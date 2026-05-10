import { db } from '@/db/index.js';
import { distributors, distributorBuyingIntent, distributorBrandMatches, leads } from '@/db/schema.js';
import { logger } from '@/lib/logger.js';
import { eq, inArray, and, max, sql } from 'drizzle-orm';

type MatchingResult = { matched: number; updated: number };

export class DistributorMatchingAgent {
  async run(): Promise<MatchingResult> {
    let matched = 0;
    let updated = 0;

    const activeleads = await db
      .select({
        id: leads.id,
        brandId: leads.brandId,
        bestCategory: leads.bestCategory,
        bestCountryCode: leads.bestCountryCode,
        categories: leads.categories,
      })
      .from(leads)
      .where(
        and(
          inArray(leads.status, ['new', 'reviewed', 'approved']),
          sql`${leads.bestCountryCode} IS NOT NULL`,
        ),
      );

    for (const lead of activeleads) {
      const leadCategories = lead.categories ?? (lead.bestCategory ? [lead.bestCategory] : []);
      if (leadCategories.length === 0 || !lead.bestCountryCode) continue;

      // Find distributors in same country with overlapping categories
      const candidateDistributors = await db
        .select({
          id: distributors.id,
          categories: distributors.categories,
          distributorScore: distributors.distributorScore,
        })
        .from(distributors)
        .where(
          and(
            eq(distributors.countryCode, lead.bestCountryCode),
            sql`${distributors.categories} && ARRAY[${sql.join(leadCategories.map(c => sql`${c}`), sql`, `)}]::text[]`,
          ),
        );

      let matchesForLead = 0;

      for (const dist of candidateDistributors) {
        const distCategories = dist.categories ?? [];

        // Category overlap score (0–1)
        const overlapping = leadCategories.filter(c => distCategories.includes(c));
        const categoryOverlap = leadCategories.length > 0 ? overlapping.length / leadCategories.length : 0;
        if (categoryOverlap === 0) continue;

        // Max intent strength for any overlapping category
        const intentResult = await db
          .select({ maxStrength: max(distributorBuyingIntent.intentStrength) })
          .from(distributorBuyingIntent)
          .where(
            and(
              eq(distributorBuyingIntent.distributorId, dist.id),
              inArray(distributorBuyingIntent.category, overlapping),
            ),
          );
        const maxIntentStrength = Number(intentResult[0]?.maxStrength ?? 0);

        const matchScore =
          categoryOverlap             * 0.50 +
          maxIntentStrength           * 0.35 +
          ((dist.distributorScore ?? 0) / 100) * 0.15;

        if (matchScore < 0.30) continue;

        const reasons: string[] = [];
        if (categoryOverlap > 0)        reasons.push('category_alignment');
        if (maxIntentStrength > 0.5)    reasons.push('intent_signal');
        reasons.push('country_match');

        await db
          .insert(distributorBrandMatches)
          .values({
            distributorId: dist.id,
            leadId: lead.id,
            brandId: lead.brandId ?? null,
            matchScore,
            matchReasons: reasons as unknown,
            status: 'suggested',
          })
          .onConflictDoNothing();

        matched++;
        matchesForLead++;
      }

      if (matchesForLead > 0) {
        // Update distributor_match_count cache on the lead
        await db
          .update(leads)
          .set({
            distributorMatchCount: sql`(SELECT COUNT(*) FROM distributor_brand_matches WHERE lead_id = ${lead.id})`,
            updatedAt: new Date(),
          })
          .where(eq(leads.id, lead.id));
        updated++;
      }
    }

    logger.info({ matched, updated }, 'DistributorMatchingAgent completed');
    return { matched, updated };
  }
}
