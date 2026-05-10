import { db } from '@/db/index.js';
import { leads, opportunityScores, gapScores, trends } from '@/db/schema.js';
import { logger } from '@/lib/logger.js';
import { eq, desc, and, isNotNull } from 'drizzle-orm';
import { sql } from 'drizzle-orm';

const TIER_BONUS: Record<string, number> = {
  breakthrough:  100,
  accelerating:  75,
  sustained:     50,
  mature:        25,
  disrupted:     30,
  watch:         10,
};

type ScoringResult = {
  scored: number;
  skipped: number;
};

export class LeadScoringAgent {
  async run(): Promise<ScoringResult> {
    let scored = 0;
    let skipped = 0;

    // Process leads that haven't been scored yet
    const unscoredLeads = await db
      .select({
        id: leads.id,
        brandId: leads.brandId,
        categories: leads.categories,
        email: leads.email,
        linkedinUrl: leads.linkedinUrl,
        websiteUrl: leads.websiteUrl,
        distributorMatchCount: leads.distributorMatchCount,
        regulatoryRiskLevel: leads.regulatoryRiskLevel,
      })
      .from(leads)
      .where(eq(leads.leadQualityScore, 0));

    for (const lead of unscoredLeads) {
      try {
        const update = await this.scoreLead(lead);
        await db
          .update(leads)
          .set({ ...update, updatedAt: new Date() })
          .where(eq(leads.id, lead.id));
        scored++;
      } catch (err) {
        logger.warn({ leadId: lead.id, error: (err as Error).message }, 'Failed to score lead');
        skipped++;
      }
    }

    logger.info({ scored, skipped }, 'LeadScoringAgent completed');
    return { scored, skipped };
  }

  private async scoreLead(lead: {
    id: string;
    brandId: string | null;
    categories: string[] | null;
    email: string | null;
    linkedinUrl: string | null;
    websiteUrl: string | null;
    distributorMatchCount: number | null;
    regulatoryRiskLevel: string | null;
  }): Promise<{
    leadQualityScore: number;
    opportunityScore: number | null;
    gapScore: number | null;
    trendTier: string | null;
    bestCategory: string | null;
    bestCountryCode: string | null;
  }> {
    let compositeScore = 0;
    let gapScoreValue = 0;
    let trendTier: string | null = null;
    let bestCategory: string | null = null;
    let bestCountryCode: string | null = null;

    // Best composite score for this brand
    if (lead.brandId) {
      const bestScore = await db
        .select({
          compositeScore: opportunityScores.compositeScore,
          category: opportunityScores.category,
          countryCode: opportunityScores.countryCode,
        })
        .from(opportunityScores)
        .where(eq(opportunityScores.brandId, lead.brandId))
        .orderBy(desc(opportunityScores.compositeScore))
        .limit(1);

      if (bestScore.length > 0) {
        compositeScore = bestScore[0].compositeScore;
        bestCategory = bestScore[0].category;
        bestCountryCode = bestScore[0].countryCode;
      }
    }

    // If no brand match, try to find a corridor score by category
    if (!bestCategory && lead.categories && lead.categories.length > 0) {
      const catScore = await db
        .select({
          compositeScore: opportunityScores.compositeScore,
          category: opportunityScores.category,
          countryCode: opportunityScores.countryCode,
        })
        .from(opportunityScores)
        .where(
          and(
            sql`opportunity_scores.category = ANY(${lead.categories})`,
            eq(opportunityScores.brandId, sql`NULL`),
          ),
        )
        .orderBy(desc(opportunityScores.compositeScore))
        .limit(1);

      if (catScore.length > 0) {
        compositeScore = Math.max(compositeScore, catScore[0].compositeScore * 0.7);
        bestCategory = bestCategory ?? catScore[0].category;
        bestCountryCode = bestCountryCode ?? catScore[0].countryCode;
      }
    }

    // Best gap score for the resolved corridor
    if (bestCategory && bestCountryCode) {
      const bestGap = await db
        .select({ gapScore: gapScores.gapScore })
        .from(gapScores)
        .where(
          and(
            eq(gapScores.category, bestCategory),
            eq(gapScores.countryCode, bestCountryCode),
          ),
        )
        .orderBy(desc(gapScores.gapScore))
        .limit(1);

      if (bestGap.length > 0) gapScoreValue = bestGap[0].gapScore;

      // Latest trend tier for this corridor
      const latestTrend = await db
        .select({ opportunityTier: trends.opportunityTier })
        .from(trends)
        .where(
          and(
            eq(trends.category, bestCategory),
            eq(trends.countryCode, bestCountryCode),
            isNotNull(trends.opportunityTier),
          ),
        )
        .orderBy(desc(trends.createdAt))
        .limit(1);

      if (latestTrend.length > 0) trendTier = latestTrend[0].opportunityTier;
    }

    const trendBonus = TIER_BONUS[trendTier ?? ''] ?? 0;
    const contactBonus =
      (lead.email ? 50 : 0) + (lead.linkedinUrl ? 30 : 0) + (lead.websiteUrl ? 20 : 0);

    const distributorBonus = Math.min((lead.distributorMatchCount ?? 0) * 3, 15);
    const regulatoryPenalty = lead.regulatoryRiskLevel === 'high' ? 20
      : lead.regulatoryRiskLevel === 'medium' ? 8
      : 0;

    const raw =
      compositeScore * 0.35 +
      gapScoreValue  * 0.22 +
      trendBonus     * 0.18 +
      contactBonus   * 0.12 +
      distributorBonus -
      regulatoryPenalty;

    const leadQualityScore = Math.min(100, Math.max(0, Math.round(raw * 100) / 100));

    return {
      leadQualityScore,
      opportunityScore: compositeScore > 0 ? compositeScore : null,
      gapScore: gapScoreValue > 0 ? gapScoreValue : null,
      trendTier,
      bestCategory,
      bestCountryCode,
    };
  }
}
