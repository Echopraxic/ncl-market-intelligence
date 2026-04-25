import { db } from '@/db/index.js';
import { leads, leadCampaigns, leadBriefings, humanReviewItems, opportunityScores, gapScores, niRoutingSignals } from '@/db/schema.js';
import { logger } from '@/lib/logger.js';
import { eq, and, desc, gte, isNotNull } from 'drizzle-orm';
import { sql } from 'drizzle-orm';

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
const MAX_PER_DAY = 50;
const MIN_GAP_DAYS = 3;
const MIN_QUALITY_SCORE = 70;

type OutreachResult = {
  queued: number;
  skipped: number;
};

type LeadRow = {
  id: string;
  companyName: string;
  contactName: string | null;
  email: string | null;
  leadQualityScore: number;
  pitchAngle: string | null;
  pitchSummary: string | null;
  bestCategory: string | null;
  bestCountryCode: string | null;
  trendTier: string | null;
  gapScore: number | null;
  opportunityScore: number | null;
};

export class LeadOutreachAgent {
  async run(): Promise<OutreachResult> {
    let queued = 0;
    let skipped = 0;

    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);

    // Count today's outreach
    const sentToday = await db
      .select({ count: sql<number>`count(*)` })
      .from(leadCampaigns)
      .where(and(eq(leadCampaigns.status, 'sent'), gte(leadCampaigns.createdAt, dayStart)));

    if (Number(sentToday[0]?.count ?? 0) >= MAX_PER_DAY) {
      logger.info('Daily outreach limit reached');
      return { queued: 0, skipped: 0 };
    }

    const remaining = MAX_PER_DAY - Number(sentToday[0]?.count ?? 0);
    const minGapDate = new Date(Date.now() - MIN_GAP_DAYS * 24 * 60 * 60 * 1000);

    const qualifyingLeads = await db
      .select({
        id: leads.id,
        companyName: leads.companyName,
        contactName: leads.contactName,
        email: leads.email,
        leadQualityScore: leads.leadQualityScore,
        pitchAngle: leads.pitchAngle,
        pitchSummary: leads.pitchSummary,
        bestCategory: leads.bestCategory,
        bestCountryCode: leads.bestCountryCode,
        trendTier: leads.trendTier,
        gapScore: leads.gapScore,
        opportunityScore: leads.opportunityScore,
      })
      .from(leads)
      .where(
        and(
          eq(leads.status, 'approved'),
          gte(leads.leadQualityScore, MIN_QUALITY_SCORE),
          isNotNull(leads.email),
          isNotNull(leads.pitchAngle),
        ),
      )
      .limit(remaining);

    for (const lead of qualifyingLeads) {
      // Check minimum gap between campaigns for this lead
      const lastCampaign = await db
        .select({ createdAt: leadCampaigns.createdAt })
        .from(leadCampaigns)
        .where(eq(leadCampaigns.leadId, lead.id))
        .orderBy(desc(leadCampaigns.createdAt))
        .limit(1);

      if (lastCampaign.length > 0 && lastCampaign[0].createdAt > minGapDate) {
        skipped++;
        continue;
      }

      try {
        const corridorEvidence = await this.getCorridorEvidence(lead.bestCategory, lead.bestCountryCode);
        const { subject, body } = await this.generateEmail(lead, corridorEvidence);
        const briefingId = await this.generateBriefing(lead, corridorEvidence);
        const reviewItemId = await this.queueForReview(lead, subject, body, briefingId);

        await db.insert(leadCampaigns).values({
          leadId: lead.id,
          campaignType: 'email',
          subject,
          body,
          status: 'pending_review',
          humanReviewItemId: reviewItemId,
        });

        queued++;
        logger.info({ leadId: lead.id, company: lead.companyName }, 'Lead queued for outreach review');
      } catch (err) {
        logger.warn({ leadId: lead.id, error: (err as Error).message }, 'Failed to queue lead outreach');
        skipped++;
      }
    }

    logger.info({ queued, skipped }, 'LeadOutreachAgent completed');
    return { queued, skipped };
  }

  private async getCorridorEvidence(category: string | null, countryCode: string | null): Promise<Record<string, unknown>> {
    if (!category || !countryCode) return {};

    const [oppScore, gapScore, niSignal] = await Promise.all([
      db.select({ compositeScore: opportunityScores.compositeScore }).from(opportunityScores)
        .where(and(eq(opportunityScores.category, category), eq(opportunityScores.countryCode, countryCode), sql`brand_id IS NULL`))
        .orderBy(desc(opportunityScores.compositeScore)).limit(1),
      db.select({ gapScore: gapScores.gapScore }).from(gapScores)
        .where(and(eq(gapScores.category, category), eq(gapScores.countryCode, countryCode)))
        .orderBy(desc(gapScores.gapScore)).limit(1),
      db.select({ signalStrength: niRoutingSignals.signalStrength }).from(niRoutingSignals)
        .where(and(eq(niRoutingSignals.nclCategory, category), eq(niRoutingSignals.euCountry, countryCode)))
        .orderBy(desc(niRoutingSignals.signalStrength)).limit(1),
    ]);

    return {
      category,
      countryCode,
      compositeScore: oppScore[0]?.compositeScore ?? null,
      gapScore: gapScore[0]?.gapScore ?? null,
      niSignalStrength: niSignal[0]?.signalStrength ?? null,
    };
  }

  private async generateEmail(lead: LeadRow, evidence: Record<string, unknown>): Promise<{ subject: string; body: string }> {
    const fallbackSubject = `EU expansion opportunity in ${lead.bestCategory ?? 'your category'} — ${lead.bestCountryCode ?? 'EU'}`;
    const fallbackBody = `Hi ${lead.contactName ?? 'there'},

My name is Michael from North Channel Logistics. We help US brands expand into EU markets via our Northern Ireland corridor.

${lead.pitchSummary ?? ''}

Would you have 20 minutes to explore what this could mean for ${lead.companyName}?

Best,
Michael
North Channel Logistics`;

    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return { subject: fallbackSubject, body: fallbackBody };

    try {
      const prompt = `Write a concise B2B outreach email for NCL (North Channel Logistics). Requirements: subject line + 150-200 word email body. No fluff — every sentence must be data-backed or actionable.

Company: ${lead.companyName}
Contact: ${lead.contactName ?? 'the team'}
Category: ${lead.bestCategory}
Target market: ${lead.bestCountryCode}
Pitch angle: ${lead.pitchAngle}
Pitch hook: ${lead.pitchSummary}
Evidence: composite score ${evidence.compositeScore}, gap score ${evidence.gapScore}, NI signal ${evidence.niSignalStrength}

Format:
SUBJECT: <subject line>
BODY:
<email body>`;

      const response = await fetch(DEEPSEEK_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 300,
          temperature: 0.5,
        }),
        signal: AbortSignal.timeout(20_000),
      });

      if (!response.ok) return { subject: fallbackSubject, body: fallbackBody };
      const data = await response.json() as { choices: Array<{ message: { content: string } }> };
      const content = data.choices[0]?.message?.content?.trim() ?? '';

      const subjectMatch = content.match(/^SUBJECT:\s*(.+)$/im);
      const bodyMatch = content.match(/^BODY:\s*([\s\S]+)$/im);

      return {
        subject: subjectMatch?.[1]?.trim() ?? fallbackSubject,
        body: bodyMatch?.[1]?.trim() ?? fallbackBody,
      };
    } catch {
      return { subject: fallbackSubject, body: fallbackBody };
    }
  }

  private async generateBriefing(lead: LeadRow, evidence: Record<string, unknown>): Promise<string> {
    const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>NCL Market Brief — ${lead.companyName}</title>
<style>body{font-family:sans-serif;max-width:800px;margin:40px auto;color:#111}h1{color:#1a3a5c}h2{color:#2d6a9f;border-bottom:1px solid #ddd;padding-bottom:6px}.score{font-size:2em;font-weight:bold;color:#2d6a9f}.badge{display:inline-block;padding:4px 10px;border-radius:4px;background:#e8f4ff;color:#1a3a5c;font-size:.9em}</style>
</head>
<body>
<h1>NCL Market Intelligence Brief</h1>
<p><strong>Prepared for:</strong> ${lead.companyName} | <strong>Date:</strong> ${new Date().toLocaleDateString('en-GB')}</p>

<h2>1. Opportunity Snapshot</h2>
<p>Category: <span class="badge">${lead.bestCategory ?? 'N/A'}</span> &nbsp; Market: <span class="badge">${lead.bestCountryCode ?? 'EU'}</span></p>
<p>Composite opportunity score: <span class="score">${Math.round(evidence.compositeScore as number ?? 0)}</span>/100</p>
<p>Demand-supply gap score: <strong>${Math.round(evidence.gapScore as number ?? 0)}/100</strong> — higher = larger uncaptured opportunity</p>

<h2>2. Why Now</h2>
<p>Trend tier: <span class="badge">${lead.trendTier ?? 'sustained'}</span></p>
<p>${lead.pitchSummary ?? 'The EU market presents a strong expansion opportunity for US brands in this category.'}</p>

<h2>3. NI Routing Advantage</h2>
<p>NI routing signal strength: <strong>${Math.round((evidence.niSignalStrength as number ?? 0) * 100)}%</strong></p>
<p>Northern Ireland's dual-market position (UK customs + EU Single Market access via Windsor Framework) provides a unique logistics corridor that can reduce EU landed costs by 8–14% versus direct US-to-EU shipping.</p>

<h2>4. Next Steps</h2>
<p>We recommend a 20-minute strategy call to map your SKU range to specific EU retailer corridors. NCL provides end-to-end fulfilment, customs documentation, and distributor introductions.</p>
<p><strong>Contact:</strong> North Channel Logistics | mikeymck@umich.edu</p>
</body>
</html>`;

    const [inserted] = await db
      .insert(leadBriefings)
      .values({
        leadId: lead.id,
        title: `EU Expansion Brief — ${lead.companyName}`,
        htmlContent: html,
        evidenceData: { ...evidence, leadQualityScore: lead.leadQualityScore, pitchAngle: lead.pitchAngle },
      })
      .onConflictDoUpdate({
        target: leadBriefings.leadId,
        set: { htmlContent: html, evidenceData: { ...evidence }, generatedAt: new Date() },
      })
      .returning({ id: leadBriefings.id });

    return inserted.id;
  }

  private async queueForReview(lead: LeadRow, subject: string, body: string, briefingId: string): Promise<string> {
    const priority = Math.ceil(lead.leadQualityScore / 34); // 1–3
    const [item] = await db
      .insert(humanReviewItems)
      .values({
        type: 'lead_outreach',
        priority,
        data: {
          leadId: lead.id,
          subject,
          bodyPreview: body.slice(0, 300),
          briefingId,
          pitchAngle: lead.pitchAngle,
          corridorSummary: `${lead.bestCategory} → ${lead.bestCountryCode}`,
          leadQualityScore: lead.leadQualityScore,
        },
        reviewPrompt: `Approve to send email to ${lead.contactName ?? lead.companyName} pitching ${lead.bestCategory} EU expansion.`,
      })
      .returning({ id: humanReviewItems.id });

    return item.id;
  }
}

