import { db } from '@/db/index.js';
import { leads, leadCampaigns, leadPipeline } from '@/db/schema.js';
import { logger } from '@/lib/logger.js';
import { eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';

type ResendWebhookEvent = {
  type: string;
  data: {
    message_id?: string;
    bounce?: { type: string; message: string };
    to?: string[];
    text?: string;
  };
};

export class LeadEngagementAgent {
  async handleWebhookEvent(event: ResendWebhookEvent): Promise<void> {
    const messageId = event.data.message_id;
    if (!messageId) {
      logger.warn({ event }, 'Resend webhook event missing message_id');
      return;
    }

    const campaign = await db
      .select({ id: leadCampaigns.id, leadId: leadCampaigns.leadId })
      .from(leadCampaigns)
      .where(eq(leadCampaigns.resendMessageId, messageId))
      .limit(1);

    if (campaign.length === 0) {
      logger.debug({ messageId }, 'No campaign found for Resend message ID — ignoring');
      return;
    }

    const { id: campaignId, leadId } = campaign[0];
    const log = logger.child({ campaignId, leadId, eventType: event.type });

    switch (event.type) {
      case 'email.opened':
        await db.update(leadCampaigns)
          .set({ openedAt: new Date() })
          .where(eq(leadCampaigns.id, campaignId));
        log.info('Email opened');
        break;

      case 'email.clicked':
        await db.update(leadCampaigns)
          .set({ clickedAt: new Date() })
          .where(eq(leadCampaigns.id, campaignId));
        log.info('Email clicked');
        break;

      case 'email.bounced': {
        const isHardBounce = event.data.bounce?.type === 'hard';
        const reason = event.data.bounce?.message ?? 'bounce';
        await db.update(leadCampaigns)
          .set({ bouncedAt: new Date(), bounceReason: reason })
          .where(eq(leadCampaigns.id, campaignId));

        if (isHardBounce) {
          await db.update(leads)
            .set({ status: 'invalid', email: null, updatedAt: new Date() })
            .where(eq(leads.id, leadId));
          log.warn({ reason }, 'Hard bounce — lead marked invalid');
        } else {
          log.info({ reason }, 'Soft bounce recorded');
        }
        break;
      }

      case 'email.complained':
        await db.update(leads)
          .set({ status: 'lost', notes: 'Marked as spam by recipient', updatedAt: new Date() })
          .where(eq(leads.id, leadId));
        log.warn('Spam complaint — lead marked lost');
        break;

      case 'email.replied':
      case 'inbound_email': {
        const replyBody = event.data.text ?? '';
        const sentiment = await this.classifySentiment(replyBody);

        await db.update(leadCampaigns)
          .set({ repliedAt: new Date(), replySentiment: sentiment, replyBody: replyBody.slice(0, 2000) })
          .where(eq(leadCampaigns.id, campaignId));

        await db.update(leads)
          .set({ status: 'replied', updatedAt: new Date() })
          .where(eq(leads.id, leadId));

        // Upsert pipeline entry
        const stage = sentiment === 'positive' ? 'qualified' : 'engaged';
        const probability = sentiment === 'positive' ? 40 : 15;

        await db.insert(leadPipeline)
          .values({ leadId, stage, probabilityPercent: probability })
          .onConflictDoUpdate({
            target: leadPipeline.leadId,
            set: { stage, probabilityPercent: probability, movedAt: new Date() },
          });

        if (sentiment === 'negative') {
          await db.update(leads)
            .set({ status: 'lost', updatedAt: new Date() })
            .where(eq(leads.id, leadId));
        }

        log.info({ sentiment, stage }, 'Reply processed');
        break;
      }

      default:
        log.debug('Unhandled Resend event type');
    }
  }

  private async classifySentiment(text: string): Promise<'positive' | 'neutral' | 'negative'> {
    if (!text || text.length < 5) return 'neutral';

    const negativeKeywords = ['not interested', 'unsubscribe', 'remove', 'stop', 'no thanks', 'do not contact'];
    const positiveKeywords = ['interested', 'yes', 'sounds good', 'tell me more', 'schedule', 'call', 'meeting', 'great'];

    const lower = text.toLowerCase();
    if (negativeKeywords.some(kw => lower.includes(kw))) return 'negative';
    if (positiveKeywords.some(kw => lower.includes(kw))) return 'positive';

    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return 'neutral';

    try {
      const response = await fetch(DEEPSEEK_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [{
            role: 'user',
            content: `Classify the sentiment of this B2B email reply as exactly one of: positive, neutral, or negative. Reply with only the single word.\n\nReply: ${text.slice(0, 500)}`,
          }],
          max_tokens: 5,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) return 'neutral';
      const data = await response.json() as { choices: Array<{ message: { content: string } }> };
      const result = data.choices[0]?.message?.content?.trim().toLowerCase();
      if (result === 'positive' || result === 'negative' || result === 'neutral') return result;
      return 'neutral';
    } catch {
      return 'neutral';
    }
  }
}
