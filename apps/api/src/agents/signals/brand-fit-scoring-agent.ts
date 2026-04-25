// src/agents/signals/brand-fit-scoring-agent.ts
//
// BrandFitScoringAgent — Phase 3
//
// Scores every brand in the DB against each active corridor opportunity,
// creating one opportunity_scores row per (brandId, category, countryCode) triple.
//
// brandFitScore = 100 × (
//   0.40 × categoryMatchScore   — exact alias: 1.0, substring: 0.7
//   0.30 × revenueTierScore     — micro 0.3 / small 0.7 / mid 1.0 / large 0.5
//   0.30 × shopifySignal        — 1.0 if shopifyStoreUrl set, else 0
// ) × euPresenceMultiplier      — 0.6 if brand already has EU presence
//
// niSuitabilityPreScore = 100 × (
//   0.40 × avgNiSignal          — average of 3 NI sub-dims from niRoutingSignals
//   0.30 × usOnlyDistribution   — 1.0 if euPresence=false, 0.3 if true
//   0.30 × brandSizeFit         — micro 0.4 / small 0.8 / mid 1.0 / large 0.5
// )
//
// compositeScore = categoryOpportunityScore × 0.40 + brandFitScore × 0.35 + niSuitabilityPreScore × 0.25
//
// categoryOpportunityScore is inherited from the corridor row (brandId IS NULL)
// produced by CompositeScoringAgent. Rows are upserted on the
// opp_scores_brand_category_country_uniq partial index.

import { randomUUID } from 'crypto';
import { db } from '../../db/index.js';
import {
  brands,
  opportunityScores,
  niRoutingSignals,
  agentOutputs,
} from '../../db/schema.js';
import { and, inArray, isNull, isNotNull, sql } from 'drizzle-orm';
import { logger } from '../../lib/logger.js';
import scoringWeights from '../../config/scoring-weights.json' with { type: 'json' };

// ---------------------------------------------------------------------------
// Revenue tier scoring — Option C: explicit tier cut-offs
// ---------------------------------------------------------------------------

function revenueTierScore(annualRevenue: number | null): number {
  if (annualRevenue === null)      return 0.5; // neutral when unknown
  if (annualRevenue < 1_000_000)  return 0.3; // micro — viable but limited scale
  if (annualRevenue < 10_000_000) return 0.7; // small — good NCL fit
  if (annualRevenue < 100_000_000) return 1.0; // mid — ideal logistics partner
  return 0.5;                                   // large — may self-manage expansion
}

function brandSizeFit(annualRevenue: number | null): number {
  if (annualRevenue === null)      return 0.5;
  if (annualRevenue < 1_000_000)  return 0.4;
  if (annualRevenue < 10_000_000) return 0.8;
  if (annualRevenue < 100_000_000) return 1.0;
  return 0.5;
}

// ---------------------------------------------------------------------------
// Category alias lookup built once at import time
// Maps NCL snake_case key → Set of lowercased alias strings (including the key itself)
// ---------------------------------------------------------------------------

const _aliasByNclCategory = new Map<string, Set<string>>();
for (const [nclKey, aliases] of Object.entries(scoringWeights.categoryAliases)) {
  const lowerSet = new Set<string>();
  lowerSet.add(nclKey.toLowerCase());
  for (const a of aliases) lowerSet.add(a.toLowerCase());
  _aliasByNclCategory.set(nclKey, lowerSet);
}

/**
 * Returns a match score (0–1) for how well a brand's free-text categories
 * align with a given NCL category.
 * 1.0 = exact alias match (case-insensitive)
 * 0.7 = one string is a substring of the other
 * 0   = no match
 */
function getCategoryMatchScore(brandCategories: string[], nclCategory: string): number {
  const aliases = _aliasByNclCategory.get(nclCategory);
  if (!aliases) return 0;

  let best = 0;
  outer: for (const brandCat of brandCategories) {
    const lower = brandCat.toLowerCase().trim();
    for (const alias of aliases) {
      if (lower === alias) {
        best = 1.0;
        break outer;
      }
      if (lower.includes(alias) || alias.includes(lower)) {
        best = Math.max(best, 0.7);
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BrandFitScoringResult {
  brandsEvaluated: number;
  brandsWithMatches: number;
  brandCorridorPairsWritten: number;
  above80: number;
  above70: number;
}

interface CorridorRow {
  category: string;
  countryCode: string;
  categoryOpportunityScore: number;
}

interface BrandRow {
  id: string;
  categories: string[] | null;
  annualRevenueEstimate: number | null;
  euPresence: boolean | null;
  shopifyStoreUrl: string | null;
}

// ---------------------------------------------------------------------------
// BrandFitScoringAgent
// ---------------------------------------------------------------------------

export class BrandFitScoringAgent {

  // ── 1. Data fetchers ────────────────────────────────────────────────────

  private async fetchBrands(): Promise<BrandRow[]> {
    return db.select({
      id:                   brands.id,
      categories:           brands.categories,
      annualRevenueEstimate: brands.annualRevenueEstimate,
      euPresence:           brands.euPresence,
      shopifyStoreUrl:      brands.shopifyStoreUrl,
    }).from(brands);
  }

  /** Fetch corridor-level scores (brandId IS NULL) as the category dimension input. */
  private async fetchCorridors(): Promise<CorridorRow[]> {
    return db.select({
      category:                 opportunityScores.category,
      countryCode:              opportunityScores.countryCode,
      categoryOpportunityScore: opportunityScores.categoryOpportunityScore,
    }).from(opportunityScores)
      .where(isNull(opportunityScores.brandId));
  }

  /**
   * Fetch NI routing signals for the active categories and countries.
   * Returns Map keyed by 'category:countryCode:subDimension' → max signalStrength.
   * Signals with euCountry='ALL' are fanned out to every active country.
   */
  private async fetchNiSignalMap(
    categories: string[],
    countries: string[],
  ): Promise<Map<string, number>> {
    if (categories.length === 0) return new Map();

    const rows = await db.select({
      nclCategory:    niRoutingSignals.nclCategory,
      euCountry:      niRoutingSignals.euCountry,
      niSubDimension: niRoutingSignals.niSubDimension,
      signalStrength: niRoutingSignals.signalStrength,
    }).from(niRoutingSignals)
      .where(
        and(
          inArray(niRoutingSignals.nclCategory, categories),
          inArray(niRoutingSignals.euCountry, [...countries, 'ALL']),
        ),
      );

    const result = new Map<string, number>();
    for (const row of rows) {
      const targets = row.euCountry === 'ALL' ? countries : [row.euCountry];
      for (const country of targets) {
        const key = `${row.nclCategory}:${country}:${row.niSubDimension}`;
        const current = result.get(key) ?? 0;
        if (row.signalStrength > current) result.set(key, row.signalStrength);
      }
    }
    return result;
  }

  // ── 2. Sub-score computation ─────────────────────────────────────────────

  private computeBrandFitScore(params: {
    categoryMatchScore: number;
    annualRevenue:      number | null;
    shopifyStoreUrl:    string | null;
    euPresence:         boolean;
  }): { score: number; factors: Record<string, number> } {
    const { categoryMatchScore, annualRevenue, shopifyStoreUrl, euPresence } = params;

    const rts        = revenueTierScore(annualRevenue);
    const shopify    = shopifyStoreUrl ? 1.0 : 0.0;
    const euMult     = euPresence ? 0.6 : 1.0;

    const raw   = 0.40 * categoryMatchScore + 0.30 * rts + 0.30 * shopify;
    const score = Math.min(100, Math.max(0, 100 * raw * euMult));

    return {
      score,
      factors: {
        categoryMatchScore,
        revenueTierScore:     rts,
        shopifySignal:        shopify,
        euPresenceMultiplier: euMult,
      },
    };
  }

  private computeNiSuitabilityScore(params: {
    category:    string;
    countryCode: string;
    annualRevenue: number | null;
    euPresence:  boolean;
    niSignals:   Map<string, number>;
  }): { score: number; factors: Record<string, number> } {
    const { category, countryCode, annualRevenue, euPresence, niSignals } = params;

    const dims = ['vat_advantage', 'distribution_efficiency', 'regulatory_clarity'];
    const strengths    = dims.map(d => niSignals.get(`${category}:${countryCode}:${d}`) ?? 0);
    const avgNiSignal  = strengths.reduce((a, b) => a + b, 0) / dims.length;

    const usOnlyDist   = euPresence ? 0.3 : 1.0;
    const sizeFit      = brandSizeFit(annualRevenue);

    const raw   = 0.40 * avgNiSignal + 0.30 * usOnlyDist + 0.30 * sizeFit;
    const score = Math.min(100, Math.max(0, 100 * raw));

    return {
      score,
      factors: {
        avgNiSignal,
        usOnlyDistribution: usOnlyDist,
        brandSizeFit:       sizeFit,
      },
    };
  }

  // ── 3. Main run ──────────────────────────────────────────────────────────

  async run(): Promise<BrandFitScoringResult> {
    logger.info({ agent: 'BrandFitScoringAgent' }, 'Starting brand fit scoring run');

    const [allBrands, corridors] = await Promise.all([
      this.fetchBrands(),
      this.fetchCorridors(),
    ]);

    if (allBrands.length === 0 || corridors.length === 0) {
      logger.warn(
        { agent: 'BrandFitScoringAgent', brands: allBrands.length, corridors: corridors.length },
        'No brands or corridor scores available — skipping',
      );
      return { brandsEvaluated: allBrands.length, brandsWithMatches: 0, brandCorridorPairsWritten: 0, above80: 0, above70: 0 };
    }

    const allCategories = [...new Set(corridors.map(c => c.category))];
    const allCountries  = [...new Set(corridors.map(c => c.countryCode))];
    const niSignalMap   = await this.fetchNiSignalMap(allCategories, allCountries);

    // Group corridors by NCL category for O(1) lookup per brand×category
    const corridorsByCategory = new Map<string, CorridorRow[]>();
    for (const c of corridors) {
      const list = corridorsByCategory.get(c.category) ?? [];
      list.push(c);
      corridorsByCategory.set(c.category, list);
    }

    let brandsWithMatches   = 0;
    let pairsWritten        = 0;
    let above80             = 0;
    let above70             = 0;
    const upsertedIds: string[] = [];

    const roundTo2 = (v: number) => Math.round(v * 100) / 100;

    for (const brand of allBrands) {
      const brandCats = brand.categories ?? [];
      if (brandCats.length === 0) continue;

      const euPresence = brand.euPresence ?? false;
      let brandHadMatch = false;

      for (const nclCategory of allCategories) {
        const matchScore = getCategoryMatchScore(brandCats, nclCategory);
        if (matchScore === 0) continue; // brand doesn't operate in this category

        const corridorList = corridorsByCategory.get(nclCategory) ?? [];

        for (const corridor of corridorList) {
          const { score: brandFitScore, factors: brandFactors } = this.computeBrandFitScore({
            categoryMatchScore: matchScore,
            annualRevenue:      brand.annualRevenueEstimate,
            shopifyStoreUrl:    brand.shopifyStoreUrl,
            euPresence,
          });

          const { score: niSuitabilityPreScore, factors: niFactors } = this.computeNiSuitabilityScore({
            category:    nclCategory,
            countryCode: corridor.countryCode,
            annualRevenue: brand.annualRevenueEstimate,
            euPresence,
            niSignals:   niSignalMap,
          });

          const categoryOpportunityScore = corridor.categoryOpportunityScore;
          const compositeScore =
            categoryOpportunityScore * 0.40 +
            brandFitScore            * 0.35 +
            niSuitabilityPreScore    * 0.25;

          const rowId = randomUUID();

          await db.insert(opportunityScores)
            .values({
              id:                       rowId,
              brandId:                  brand.id,
              category:                 nclCategory,
              countryCode:              corridor.countryCode,
              categoryOpportunityScore: roundTo2(categoryOpportunityScore),
              brandFitScore:            roundTo2(brandFitScore),
              niSuitabilityPreScore:    roundTo2(niSuitabilityPreScore),
              compositeScore:           roundTo2(compositeScore),
              scoringFactors: {
                brand: brandFactors,
                ni:    niFactors,
                inputs: {
                  annualRevenue: brand.annualRevenueEstimate,
                  euPresence,
                  hasShopify:    !!brand.shopifyStoreUrl,
                  matchedCategory: nclCategory,
                  categoryMatchScore: matchScore,
                },
              } as unknown as Record<string, unknown>,
              generatedAt: new Date(),
            })
            .onConflictDoUpdate({
              target:      [opportunityScores.brandId, opportunityScores.category, opportunityScores.countryCode],
              targetWhere: isNotNull(opportunityScores.brandId),
              set: {
                categoryOpportunityScore: roundTo2(categoryOpportunityScore),
                brandFitScore:            roundTo2(brandFitScore),
                niSuitabilityPreScore:    roundTo2(niSuitabilityPreScore),
                compositeScore:           roundTo2(compositeScore),
                scoringFactors: {
                  brand: brandFactors,
                  ni:    niFactors,
                  inputs: {
                    annualRevenue: brand.annualRevenueEstimate,
                    euPresence,
                    hasShopify:    !!brand.shopifyStoreUrl,
                    matchedCategory: nclCategory,
                    categoryMatchScore: matchScore,
                  },
                } as unknown as Record<string, unknown>,
                generatedAt: new Date(),
              },
            });

          upsertedIds.push(rowId);
          if (compositeScore >= 80) above80++;
          if (compositeScore >= 70) above70++;
          pairsWritten++;
          brandHadMatch = true;
        }
      }

      if (brandHadMatch) brandsWithMatches++;
    }

    const result: BrandFitScoringResult = {
      brandsEvaluated:          allBrands.length,
      brandsWithMatches,
      brandCorridorPairsWritten: pairsWritten,
      above80,
      above70,
    };

    await db.insert(agentOutputs).values({
      agentType:  'brand_fit_scoring',
      outputData: {
        runAt:                     new Date().toISOString(),
        brandsEvaluated:           allBrands.length,
        brandsWithMatches,
        brandCorridorPairsWritten: pairsWritten,
        above80,
        above70,
      } as unknown as Record<string, unknown>,
      relatedEntityIds: upsertedIds,
    });

    logger.info(
      {
        agent:              'BrandFitScoringAgent',
        brandsEvaluated:    allBrands.length,
        brandsWithMatches,
        pairsWritten,
        above80,
        above70,
      },
      'Brand fit scoring run complete',
    );

    return result;
  }
}
