import { db } from '@/db/index.js';
import { leads, niRoutingSignals, distributorBrandMatches, distributors, distributorBuyingIntent, regulatoryFlags } from '@/db/schema.js';
import { logger } from '@/lib/logger.js';
import { eq, and, isNull, avg, sql, or } from 'drizzle-orm';

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

        const [niStrength, distMatches, topFlag] = await Promise.all([
          this.getNISignalStrength(lead.bestCategory, lead.bestCountryCode),
          this.getDistributorMatches(lead.id),
          this.getTopRegulatoryFlag(lead.bestCategory, lead.bestCountryCode),
        ]);

        const { angle, template } = this.selectAngle(lead, niStrength, distMatches);
        const pitchSummary = await this.expandSummary(
          lead.companyName, lead.bestCategory, lead.bestCountryCode,
          angle, template, lead, distMatches, topFlag,
        );

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
    distMatches: Array<{ name: string; countryCode: string }>,
  ): { angle: string; template: string } {
    const gap = lead.gapScore ?? 0;
    const tier = lead.trendTier ?? '';

    if (distMatches.length >= 2) {
      const countries = [...new Set(distMatches.map(m => m.countryCode))].join(', ');
      return {
        angle: 'distributor_pull',
        template: `${distMatches.length} EU distributors in our network (${countries}) are actively sourcing this category right now.`,
      };
    }

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

  private async getDistributorMatches(leadId: string): Promise<Array<{ name: string; countryCode: string; intentStrength: number | null }>> {
    try {
      return await db
        .select({
          name: distributors.name,
          countryCode: distributors.countryCode,
          intentStrength: distributorBuyingIntent.intentStrength,
        })
        .from(distributorBrandMatches)
        .innerJoin(distributors, eq(distributorBrandMatches.distributorId, distributors.id))
        .leftJoin(
          distributorBuyingIntent,
          and(
            eq(distributorBuyingIntent.distributorId, distributors.id),
          ),
        )
        .where(eq(distributorBrandMatches.leadId, leadId))
        .limit(5);
    } catch {
      return [];
    }
  }

  private async getTopRegulatoryFlag(category: string, countryCode: string): Promise<{ riskLevel: string; description: string } | null> {
    try {
      const flags = await db
        .select({ riskLevel: regulatoryFlags.riskLevel, description: regulatoryFlags.description })
        .from(regulatoryFlags)
        .where(
          or(
            and(eq(regulatoryFlags.category, category), eq(regulatoryFlags.countryCode, countryCode)),
            and(eq(regulatoryFlags.category, category), eq(regulatoryFlags.countryCode, 'EU')),
          ),
        )
        .orderBy(sql`CASE ${regulatoryFlags.riskLevel} WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC`)
        .limit(1);
      return flags[0] ?? null;
    } catch {
      return null;
    }
  }

  private async expandSummary(
    companyName: string,
    category: string,
    countryCode: string,
    angle: string,
    template: string,
    lead: { gapScore: number | null; trendTier: string | null },
    distMatches: Array<{ name: string; countryCode: string }>,
    topFlag: { riskLevel: string; description: string } | null,
  ): Promise<string> {
    const base = template
      .replace('{{category}}', category)
      .replace('{{country}}', countryCode)
      .replace('{{gap}}', String(Math.round(lead.gapScore ?? 0)));

    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return base;

    const distributorContext = distMatches.length > 0
      ? `Distributor pull: ${distMatches.map(m => `${m.name} (${m.countryCode})`).join(', ')} are actively sourcing this category.`
      : '';
    const regulatoryNote = topFlag
      ? `Regulatory note (${topFlag.riskLevel} risk): ${topFlag.description}`
      : 'No known compliance barriers for this category/market.';

    try {
      const prompt = `You are writing concise, data-backed B2B outreach for NCL, a Northern Ireland logistics company. Expand this pitch hook for ${companyName} into 2–3 sentences. Keep it factual, specific, and under 60 words. No fluff.

Hook: ${base}
Pitch angle: ${angle}
Category: ${category}
Target market: ${countryCode}
Trend: ${lead.trendTier ?? 'sustained'}
${distributorContext}
${regulatoryNote}`;

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
