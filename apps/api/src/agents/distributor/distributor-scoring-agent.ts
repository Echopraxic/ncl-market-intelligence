import { db } from '@/db/index.js';
import { distributors, distributorBuyingIntent, opportunityScores } from '@/db/schema.js';
import { logger } from '@/lib/logger.js';
import { eq, gte, avg, sql } from 'drizzle-orm';

const NCL_TARGET_COUNTRIES = new Set(['DE', 'FR', 'NL', 'GB', 'ES', 'IT']);
const EU_COUNTRIES = new Set(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'GR', 'HU', 'IE', 'LV', 'LT', 'LU', 'MT', 'PL', 'PT', 'RO', 'SK', 'SI', 'SE']);

type ScoringResult = { scored: number; skipped: number };

export class DistributorScoringAgent {
  async run(): Promise<ScoringResult> {
    let scored = 0;
    let skipped = 0;

    // Fetch active NCL corridors for categoryAlignment scoring
    const activeCorridors = await db
      .select({ category: opportunityScores.category })
      .from(opportunityScores)
      .where(gte(opportunityScores.compositeScore, 60))
      .groupBy(opportunityScores.category);
    const activeCategories = new Set(activeCorridors.map(r => r.category));

    const allDistributors = await db
      .select({
        id: distributors.id,
        countryCode: distributors.countryCode,
        categories: distributors.categories,
        contactEmail: distributors.contactEmail,
        websiteUrl: distributors.websiteUrl,
        linkedinUrl: distributors.linkedinUrl,
      })
      .from(distributors);

    for (const dist of allDistributors) {
      try {
        // 1. Category alignment (0–1)
        const cats = dist.categories ?? [];
        const alignedCount = cats.filter(c => activeCategories.has(c)).length;
        const categoryAlignment = cats.length > 0 ? alignedCount / cats.length : 0;

        // 2. Market coverage (0–1)
        const marketCoverage = NCL_TARGET_COUNTRIES.has(dist.countryCode) ? 1.0
          : EU_COUNTRIES.has(dist.countryCode) ? 0.6
          : 0.2;

        // 3. Buying activity: avg intent strength
        const intentResult = await db
          .select({ avgStrength: avg(distributorBuyingIntent.intentStrength) })
          .from(distributorBuyingIntent)
          .where(eq(distributorBuyingIntent.distributorId, dist.id));
        const buyingActivity = Number(intentResult[0]?.avgStrength ?? 0);

        // 4. Contact completeness (0–1)
        const contactCompleteness =
          (dist.contactEmail ? 0.4 : 0) +
          (dist.websiteUrl   ? 0.3 : 0) +
          (dist.linkedinUrl  ? 0.3 : 0);

        const score = Math.round(
          (categoryAlignment * 0.35 +
           marketCoverage    * 0.30 +
           buyingActivity    * 0.25 +
           contactCompleteness * 0.10) * 100
        );

        await db
          .update(distributors)
          .set({ distributorScore: score, updatedAt: new Date() })
          .where(eq(distributors.id, dist.id));

        scored++;
      } catch (err) {
        logger.warn({ distributorId: dist.id, error: (err as Error).message }, 'Failed to score distributor');
        skipped++;
      }
    }

    logger.info({ scored, skipped }, 'DistributorScoringAgent completed');
    return { scored, skipped };
  }
}
