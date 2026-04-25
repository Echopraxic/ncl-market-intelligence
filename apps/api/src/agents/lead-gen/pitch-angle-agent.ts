import { db } from '@/db/index.js';
import { leads, gapScores, trends, niRoutingSignals } from '@/db/schema.js';
import { logger } from '@/lib/logger.js';
import { eq, desc, and, isNull, avg } from 'drizzle-orm';
import { sql } from 'drizzle-orm';

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';

type PitchResult = {
  processed: number;
  skipped: number;
};

export class PitchAngleAgent {
  async run(): Promise<PitchResult> {
    let processed = 0;
    let skipped = 0;

    const unPitchedLeads = await db
      .select({
        id: leads.id,
        companyName: leads.companyName,
        bestCategory: leads.bestCategory,
        bestCountryCode: leads.bestCountryCode,
        gapScore: leads.gapScore,
        trendTier: leads.trendTier,
        leadQualityScore: leads.leadQualityScore,
      })
      .from(leads)
      .where(isNull(leads.pitchAngle));

    for (const lead of unPitchedLeads) {
      try {
        if (!lead.bestCategory || !lead.bestCountryCode) {
          skipped++;
          continue;
        }

        const niStrength = await this.getNISignalStrength(lead.bestCategory, lead.bestCountryCode);
        const { angle, template } = this.selectAngle(lead, niStrength);
        const pitchSummary = await this.expandSummary(lead.companyName, lead.bestCategory, lead.bestCountryCode, angle, template, lead);

        await db
          .update(leads)
          .set({ pitchAngle: angle, pitchSummary, updatedAt: new Date() })
          .where(eq(leads.id, lead.id));

        processed++;
      } catch (err) {
        logger.warn({ leadId: lead.id, error: (err as Error).message }, 'Failed to generate pitch angle');
        skipped++;
      }
    }

    logger.info({ processed, skipped }, 'PitchAngleAgent completed');
    return { processed, skipped };
  }

  private selectAngle(
    lead: { gapScore: number | null; trendTier: string | null; leadQualityScore: number },
    niStrength: number,
  ): { angle: string; template: string } {
    const gap = lead.gapScore ?? 0;
    const tier = lead.trendTier ?? '';

    if (gap > 70 && ['breakthrough', 'accelerating'].includes(tier)) {
      return {
        angle: 'first_mover',
        template: `The {{category}} market in {{country}} is growing rapidly and US brands are underrepresented — your competitors haven't moved yet.`,
      };
    }
    if (gap > 60) {
      return {
        angle: 'unmet_demand',
        template: `EU retailers in {{country}} are actively sourcing {{category}} products with limited US representation (gap score: {{gap}}/100).`,
      };
    }
    if (niStrength > 0.7) {
      return {
        angle: 'cost_optimisation',
        template: `NI routing cuts your EU landed cost by an estimated 8–14% versus direct shipping from the US via our Windsor Framework-structured corridor.`,
      };
    }
    return {
      angle: 'margin_expansion',
      template: `The {{category}} category in {{country}} commands materially higher average unit values than the US equivalent (UN Comtrade 2023), creating a strong margin expansion case.`,
    };
  }

  private async getNISignalStrength(category: string, countryCode: string): Promise<number> {
    try {
      const result = await db
        .select({ avg: avg(niRoutingSignals.signalStrength) })
        .from(niRoutingSignals)
        .where(
          and(
            eq(niRoutingSignals.nclCategory, category),
            eq(niRoutingSignals.euCountry, countryCode),
          ),
        );
      return Number(result[0]?.avg ?? 0);
    } catch {
      return 0;
    }
  }

  private async expandSummary(
    companyName: string,
    category: string,
    countryCode: string,
    angle: string,
    template: string,
    lead: { gapScore: number | null; trendTier: string | null },
  ): Promise<string> {
    const base = template
      .replace('{{category}}', category)
      .replace('{{country}}', countryCode)
      .replace('{{gap}}', String(Math.round(lead.gapScore ?? 0)));

    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return base;

    try {
      const prompt = `You are writing concise, data-backed B2B outreach for NCL, a Northern Ireland logistics company. Expand this pitch hook for ${companyName} into 2–3 sentences. Keep it factual, specific, and under 60 words. No fluff.

Hook: ${base}
Pitch angle: ${angle}
Category: ${category}
Target market: ${countryCode}
Trend: ${lead.trendTier ?? 'sustained'}`;

      const response = await fetch(DEEPSEEK_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 120,
          temperature: 0.4,
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) return base;
      const data = await response.json() as { choices: Array<{ message: { content: string } }> };
      return data.choices[0]?.message?.content?.trim() ?? base;
    } catch {
      return base;
    }
  }
}
