// src/agents/signals/composite-scoring-agent.ts
//
// CompositeScoringAgent — Phase 3 core scoring engine.
//
// Produces one opportunity_scores row per (category, countryCode) corridor
// (brandId = null) using the three-dimension formula:
//
//   compositeScore = (categoryScore × 0.40) + (brandScore × 0.35) + (niScore × 0.25)
//
// All sub-scores are 0–100. Results are upserted so re-runs safely overwrite
// stale scores for the same corridor.
//
// Data freshness window: corridors are sourced from trends created in the last
// 90 days. All supporting data (gap scores, trade flow, NI signals, retailer
// insights) is fetched in bulk upfront to minimise DB round-trips.

import { randomUUID } from 'crypto';
import { db } from '../../db/index.js';
import {
  trends,
  gapScores,
  tradeFlowIntelligence,
  niRoutingSignals,
  retailerInsights,
  opportunityScores,
  agentOutputs,
} from '../../db/schema.js';
import { and, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { logger } from '../../lib/logger.js';
import scoringWeights from '../../config/scoring-weights.json' with { type: 'json' };

// ---------------------------------------------------------------------------
// Module-level: build the regulatory lookup map once at import time.
//
// The regulatoryComplexityLookup keys are free-text labels (e.g. "Food & Beverage").
// categoryAliases maps NCL snake_case keys to arrays of free-text synonyms.
// We invert this to create: nclCategory → complexityScore (0–1).
//
// resolveRegulatoryScore(nclCategory) → regulatory score (0–1, higher = better)
// where score = 1 − complexity so that lower-regulation categories score higher.
// ---------------------------------------------------------------------------

const _regComplexityByNclCategory = new Map<string, number>();

for (const [nclKey, aliases] of Object.entries(scoringWeights.categoryAliases)) {
  for (const alias of aliases) {
    const aliasLower = alias.toLowerCase();
    for (const [label, complexity] of Object.entries(scoringWeights.regulatoryComplexityLookup)) {
      if (label.toLowerCase() === aliasLower) {
        // Store only the first match per NCL key (highest-priority alias wins)
        if (!_regComplexityByNclCategory.has(nclKey)) {
          _regComplexityByNclCategory.set(nclKey, complexity as number);
        }
      }
    }
  }
  // Also try matching by NCL key itself against the lookup labels
  if (!_regComplexityByNclCategory.has(nclKey)) {
    for (const [label, complexity] of Object.entries(scoringWeights.regulatoryComplexityLookup)) {
      if (label.toLowerCase() === nclKey.toLowerCase()) {
        _regComplexityByNclCategory.set(nclKey, complexity as number);
      }
    }
  }
}

function resolveRegulatoryScore(nclCategory: string): number {
  const complexity = _regComplexityByNclCategory.get(nclCategory.toLowerCase());
  if (complexity === undefined) return 0.5; // neutral fallback when no match
  return 1 - complexity;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompositeScoringResult {
  corridorsScored: number;
  above80: number;         // compositeScore >= 80 — auto-queue outreach threshold
  above70: number;         // compositeScore >= 70 — human review threshold
  topCorridors: Array<{ category: string; countryCode: string; compositeScore: number }>;
}

interface Corridor {
  category: string;
  countryCode: string;
}

interface GapScoreRow {
  gapScore: number;
  demandPercentile: number;
  importPercentile: number;
  densityPercentile: number;
}

interface ScoringFactors {
  category: {
    demandGrowth: number;
    marginPotential: number;
    regulatoryScore: number;
    logisticsFeasibility: number;
    total: number;
  };
  brand: {
    euDemandSignalStrength: number;
    productMarketFit: number;
    logisticsViability: number;
    total: number;
  };
  ni: {
    vatAdvantage: number;
    distributionEfficiency: number;
    regulatoryClarity: number;
    total: number;
    signalCount: number;
  };
  inputs: {
    gapScore: number | null;
    demandPercentile: number | null;
    unitValueNorm: number;
    niSignalCount: number;
    usBrandEntryConfidence: number;
  };
}

// ---------------------------------------------------------------------------
// CompositeScoringAgent
// ---------------------------------------------------------------------------

export class CompositeScoringAgent {

  // ── 1. Candidate corridor discovery ─────────────────────────────────────

  private async getCandidateCorridors(): Promise<Corridor[]> {
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

    const rows = await db
      .selectDistinct({ category: trends.category, countryCode: trends.countryCode })
      .from(trends)
      .where(gte(trends.createdAt, cutoff));

    return rows.map(r => ({ category: r.category, countryCode: r.countryCode }));
  }

  // ── 2. Bulk data fetchers ────────────────────────────────────────────────

  /**
   * Fetch the latest gap score per corridor, deduplicated in JS by generatedAt.
   * Returns Map keyed by 'category:countryCode'.
   */
  private async fetchGapScores(corridors: Corridor[]): Promise<Map<string, GapScoreRow>> {
    const categories = [...new Set(corridors.map(c => c.category))];
    const countries  = [...new Set(corridors.map(c => c.countryCode))];

    if (categories.length === 0) return new Map();

    const rows = await db
      .select({
        category:         gapScores.category,
        countryCode:      gapScores.countryCode,
        gapScore:         gapScores.gapScore,
        demandPercentile: gapScores.demandPercentile,
        importPercentile: gapScores.importPercentile,
        densityPercentile: gapScores.densityPercentile,
        generatedAt:      gapScores.generatedAt,
      })
      .from(gapScores)
      .where(
        and(
          inArray(gapScores.category, categories),
          inArray(gapScores.countryCode, countries),
        ),
      );

    // Keep only the latest row per corridor
    const latestByKey = new Map<string, typeof rows[0]>();
    for (const row of rows) {
      const key = `${row.category}:${row.countryCode}`;
      const existing = latestByKey.get(key);
      if (!existing || row.generatedAt > existing.generatedAt) {
        latestByKey.set(key, row);
      }
    }

    const result = new Map<string, GapScoreRow>();
    for (const [key, row] of latestByKey) {
      result.set(key, {
        gapScore:          row.gapScore,
        demandPercentile:  row.demandPercentile,
        importPercentile:  row.importPercentile,
        densityPercentile: row.densityPercentile,
      });
    }
    return result;
  }

  /**
   * Fetch max unitValueUsdPerKg per nclCategory from us_to_eu trade flows,
   * then min-max normalise across categories.
   * Returns Map<category, normalised 0-1>.
   */
  private async fetchMarginPotential(): Promise<Map<string, number>> {
    const rows = await db
      .select({
        nclCategory:      tradeFlowIntelligence.nclCategory,
        unitValueUsdPerKg: tradeFlowIntelligence.unitValueUsdPerKg,
      })
      .from(tradeFlowIntelligence)
      .where(eq(tradeFlowIntelligence.flowType, 'us_to_eu'));

    // Aggregate max unit value per category
    const maxByCategory = new Map<string, number>();
    for (const row of rows) {
      if (row.unitValueUsdPerKg == null) continue;
      const current = maxByCategory.get(row.nclCategory) ?? 0;
      if (row.unitValueUsdPerKg > current) {
        maxByCategory.set(row.nclCategory, row.unitValueUsdPerKg);
      }
    }

    if (maxByCategory.size === 0) return new Map();

    // Min-max normalise
    const values = [...maxByCategory.values()];
    const minVal = Math.min(...values);
    const maxVal = Math.max(...values);
    const range  = maxVal - minVal;

    const result = new Map<string, number>();
    for (const [cat, val] of maxByCategory) {
      result.set(cat, range === 0 ? 0 : (val - minVal) / range);
    }
    return result;
  }

  /**
   * Fetch all NI routing signals for the corridors and group by
   * 'category:countryCode:subDimension' → max signalStrength.
   */
  private async fetchNiSignals(
    corridors: Corridor[],
  ): Promise<Map<string, number>> {
    const categories = [...new Set(corridors.map(c => c.category))];
    const countries  = [...new Set(corridors.map(c => c.countryCode))];

    if (categories.length === 0) return new Map();

    const rows = await db
      .select({
        nclCategory:    niRoutingSignals.nclCategory,
        euCountry:      niRoutingSignals.euCountry,
        niSubDimension: niRoutingSignals.niSubDimension,
        signalStrength: niRoutingSignals.signalStrength,
      })
      .from(niRoutingSignals)
      .where(
        and(
          inArray(niRoutingSignals.nclCategory, categories),
          inArray(niRoutingSignals.euCountry, [...countries, 'ALL']),
        ),
      );

    // Group by category:countryCode:subDimension → max strength
    // NI signals with euCountry='ALL' apply to every corridor in that category.
    const result = new Map<string, number>();

    for (const row of rows) {
      const targetCountries = row.euCountry === 'ALL' ? countries : [row.euCountry];
      for (const country of targetCountries) {
        const key   = `${row.nclCategory}:${country}:${row.niSubDimension}`;
        const current = result.get(key) ?? 0;
        if (row.signalStrength > current) {
          result.set(key, row.signalStrength);
        }
      }
    }

    return result;
  }

  /**
   * Fetch retailer insights of patternType='us_brand_entry' and return
   * Map<'category:countryCode', maxConfidence>.
   */
  private async fetchRetailerInsights(
    corridors: Corridor[],
  ): Promise<Map<string, number>> {
    const categories = [...new Set(corridors.map(c => c.category))];
    const countries  = [...new Set(corridors.map(c => c.countryCode))];

    if (categories.length === 0) return new Map();

    const rows = await db
      .select({
        category:    retailerInsights.category,
        countryCode: retailerInsights.countryCode,
        confidence:  retailerInsights.confidence,
      })
      .from(retailerInsights)
      .where(
        and(
          eq(retailerInsights.patternType, 'us_brand_entry'),
          inArray(retailerInsights.category, categories),
          inArray(retailerInsights.countryCode, countries),
        ),
      );

    const result = new Map<string, number>();
    for (const row of rows) {
      const key     = `${row.category}:${row.countryCode}`;
      const current = result.get(key) ?? 0;
      if (row.confidence > current) {
        result.set(key, row.confidence);
      }
    }
    return result;
  }

  /**
   * Fetch the latest trend (highest growthRate) per corridor for fallback
   * when no gap score exists.
   * Returns Map<'category:countryCode', growthRate>.
   */
  private async fetchTrendGrowthRates(
    corridors: Corridor[],
  ): Promise<Map<string, number>> {
    const categories = [...new Set(corridors.map(c => c.category))];
    const countries  = [...new Set(corridors.map(c => c.countryCode))];
    const cutoff     = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

    if (categories.length === 0) return new Map();

    const rows = await db
      .select({
        category:    trends.category,
        countryCode: trends.countryCode,
        growthRate:  trends.growthRate,
        createdAt:   trends.createdAt,
      })
      .from(trends)
      .where(
        and(
          gte(trends.createdAt, cutoff),
          inArray(trends.category, categories),
          inArray(trends.countryCode, countries),
        ),
      );

    // Keep the most recent row per corridor as fallback
    const latestByKey = new Map<string, typeof rows[0]>();
    for (const row of rows) {
      const key = `${row.category}:${row.countryCode}`;
      const existing = latestByKey.get(key);
      if (!existing || row.createdAt > existing.createdAt) {
        latestByKey.set(key, row);
      }
    }

    const result = new Map<string, number>();
    for (const [key, row] of latestByKey) {
      result.set(key, row.growthRate);
    }
    return result;
  }

  // ── 3. Sub-score computation ─────────────────────────────────────────────

  /**
   * Compute the CategoryScore (0–100) for one corridor.
   *
   * CategoryScore = 100 × (
   *   0.30 × demandGrowth +
   *   0.25 × marginPotential +
   *   0.25 × regulatoryScore +
   *   0.20 × logisticsFeasibility
   * )
   */
  private computeCategoryScore(params: {
    category:            string;
    countryCode:         string;
    gapRow:              GapScoreRow | undefined;
    trendGrowthRate:     number | undefined;
    trendGrowthRatesBatch: number[];  // all growth rates in batch for min-max
    marginNorm:          number;      // 0-1
    niSignals:           Map<string, number>;
  }): { score: number; factors: ScoringFactors['category'] } {
    const { category, countryCode, gapRow, trendGrowthRate, trendGrowthRatesBatch, marginNorm, niSignals } = params;

    // demandGrowth: use gap score's demandPercentile if available, else normalise growthRate
    let demandGrowth: number;
    if (gapRow) {
      demandGrowth = gapRow.demandPercentile; // already 0-1
    } else if (trendGrowthRate !== undefined && trendGrowthRatesBatch.length > 1) {
      const min = Math.min(...trendGrowthRatesBatch);
      const max = Math.max(...trendGrowthRatesBatch);
      const range = max - min;
      demandGrowth = range === 0 ? 0.5 : (trendGrowthRate - min) / range;
    } else {
      demandGrowth = 0;
    }

    // regulatoryScore: 1 - complexity (higher = less burden = better)
    const regulatoryScore = resolveRegulatoryScore(category);

    // logisticsFeasibility: average of all NI signal strengths for this corridor
    const niDimensions    = ['vat_advantage', 'distribution_efficiency', 'regulatory_clarity'];
    const niStrengths     = niDimensions
      .map(dim => niSignals.get(`${category}:${countryCode}:${dim}`) ?? 0);
    const hasAnyNiSignal  = niStrengths.some(s => s > 0);
    const logisticsFeasibility = hasAnyNiSignal
      ? niStrengths.reduce((a, b) => a + b, 0) / niStrengths.length
      : 0; // no evidence = no logistic advantage

    const raw =
      0.30 * demandGrowth +
      0.25 * marginNorm +
      0.25 * regulatoryScore +
      0.20 * logisticsFeasibility;

    const score = Math.min(100, Math.max(0, 100 * raw));

    return {
      score,
      factors: {
        demandGrowth,
        marginPotential:    marginNorm,
        regulatoryScore,
        logisticsFeasibility,
        total: score,
      },
    };
  }

  /**
   * Compute the BrandScore (0–100) for one corridor (no specific brand).
   *
   * BrandScore = 100 × (
   *   0.375   × euDemandSignalStrength +
   *   0.3125  × productMarketFit +
   *   0.3125  × logisticsViability
   * )
   *
   * priceCompetitiveness is excluded (sparse data); its weight is redistributed
   * proportionally across the remaining three sub-dimensions.
   */
  private computeBrandScore(params: {
    category:        string;
    countryCode:     string;
    gapRow:          GapScoreRow | undefined;
    trendGrowthRate: number | undefined;
    retailerConf:    number;           // max us_brand_entry confidence, 0-1
    niSignals:       Map<string, number>;
  }): { score: number; factors: ScoringFactors['brand'] } {
    const { category, countryCode, gapRow, trendGrowthRate, retailerConf, niSignals } = params;

    // euDemandSignalStrength
    let euDemandStrength: number;
    if (gapRow) {
      euDemandStrength = gapRow.gapScore / 100;
    } else if (trendGrowthRate !== undefined) {
      euDemandStrength = Math.min(1, Math.max(0, trendGrowthRate)); // growthRate is decimal e.g. 0.35
    } else {
      euDemandStrength = 0;
    }

    // productMarketFit: best us_brand_entry retailer confidence for corridor
    const productMarketFit = retailerConf; // 0 if no insight exists

    // logisticsViability: same NI average as logisticsFeasibility in CategoryScore
    const niDimensions   = ['vat_advantage', 'distribution_efficiency', 'regulatory_clarity'];
    const niStrengths    = niDimensions
      .map(dim => niSignals.get(`${category}:${countryCode}:${dim}`) ?? 0);
    const hasAnyNiSignal = niStrengths.some(s => s > 0);
    const logisticsViability = hasAnyNiSignal
      ? niStrengths.reduce((a, b) => a + b, 0) / niStrengths.length
      : 0;

    const raw =
      0.375  * euDemandStrength +
      0.3125 * productMarketFit +
      0.3125 * logisticsViability;

    const score = Math.min(100, Math.max(0, 100 * raw));

    return {
      score,
      factors: {
        euDemandSignalStrength: euDemandStrength,
        productMarketFit,
        logisticsViability,
        total: score,
      },
    };
  }

  /**
   * Compute the NIScore (0–100) for one corridor.
   *
   * NIScore = 100 × (
   *   0.40 × vatAdvantage +
   *   0.30 × distributionEfficiency +
   *   0.30 × regulatoryClarity
   * )
   *
   * If ALL three sub-dimensions are 0 (no NI signals), NIScore = 0 by design.
   */
  private computeNiScore(params: {
    category:    string;
    countryCode: string;
    niSignals:   Map<string, number>;
  }): { score: number; factors: ScoringFactors['ni'] } {
    const { category, countryCode, niSignals } = params;

    const vatAdvantage           = niSignals.get(`${category}:${countryCode}:vat_advantage`) ?? 0;
    const distributionEfficiency = niSignals.get(`${category}:${countryCode}:distribution_efficiency`) ?? 0;
    const regulatoryClarity      = niSignals.get(`${category}:${countryCode}:regulatory_clarity`) ?? 0;

    // Count distinct NI signals for this corridor (any sub-dimension)
    const signalCount = [vatAdvantage, distributionEfficiency, regulatoryClarity].filter(v => v > 0).length;

    const raw =
      0.40 * vatAdvantage +
      0.30 * distributionEfficiency +
      0.30 * regulatoryClarity;

    const score = Math.min(100, Math.max(0, 100 * raw));

    return {
      score,
      factors: {
        vatAdvantage,
        distributionEfficiency,
        regulatoryClarity,
        total: score,
        signalCount,
      },
    };
  }

  // ── 4. Main run method ───────────────────────────────────────────────────

  async run(): Promise<CompositeScoringResult> {
    logger.info({ agent: 'CompositeScoringAgent' }, 'Starting composite scoring run');

    const corridors = await this.getCandidateCorridors();

    if (corridors.length === 0) {
      logger.warn({ agent: 'CompositeScoringAgent' }, 'No candidate corridors found (no trends in last 90 days)');
      return { corridorsScored: 0, above80: 0, above70: 0, topCorridors: [] };
    }

    logger.info({ agent: 'CompositeScoringAgent', corridorCount: corridors.length }, 'Fetching bulk data');

    // Bulk fetches — all in parallel for efficiency
    const [gapScoreMap, marginMap, niSignalMap, retailerMap, trendGrowthMap] = await Promise.all([
      this.fetchGapScores(corridors),
      this.fetchMarginPotential(),
      this.fetchNiSignals(corridors),
      this.fetchRetailerInsights(corridors),
      this.fetchTrendGrowthRates(corridors),
    ]);

    // Collect all growth rates in this batch for min-max normalisation fallback
    const allGrowthRates = [...trendGrowthMap.values()];

    // ── Score each corridor ─────────────────────────────────────────────────

    const upsertedIds: string[] = [];
    const scoredRows: Array<{ category: string; countryCode: string; compositeScore: number }> = [];

    for (const corridor of corridors) {
      const corridorKey    = `${corridor.category}:${corridor.countryCode}`;
      const gapRow         = gapScoreMap.get(corridorKey);
      const trendGrowthRate = trendGrowthMap.get(corridorKey);
      const marginNorm     = marginMap.get(corridor.category) ?? 0;
      const retailerConf   = retailerMap.get(corridorKey) ?? 0;

      const { score: categoryScore, factors: categoryFactors } = this.computeCategoryScore({
        category:              corridor.category,
        countryCode:           corridor.countryCode,
        gapRow,
        trendGrowthRate,
        trendGrowthRatesBatch: allGrowthRates,
        marginNorm,
        niSignals:             niSignalMap,
      });

      const { score: brandScore, factors: brandFactors } = this.computeBrandScore({
        category:        corridor.category,
        countryCode:     corridor.countryCode,
        gapRow,
        trendGrowthRate,
        retailerConf,
        niSignals:       niSignalMap,
      });

      const { score: niScore, factors: niFactors } = this.computeNiScore({
        category:    corridor.category,
        countryCode: corridor.countryCode,
        niSignals:   niSignalMap,
      });

      const compositeScore =
        categoryScore * 0.40 +
        brandScore    * 0.35 +
        niScore       * 0.25;

      const scoringFactors: ScoringFactors = {
        category: categoryFactors,
        brand:    brandFactors,
        ni:       niFactors,
        inputs: {
          gapScore:               gapRow?.gapScore ?? null,
          demandPercentile:       gapRow?.demandPercentile ?? null,
          unitValueNorm:          marginNorm,
          niSignalCount:          niFactors.signalCount,
          usBrandEntryConfidence: retailerConf,
        },
      };

      const rowId = randomUUID();

      await db
        .insert(opportunityScores)
        .values({
          id:                       rowId,
          brandId:                  null,
          category:                 corridor.category,
          countryCode:              corridor.countryCode,
          categoryOpportunityScore: Math.round(categoryScore * 100) / 100,
          brandFitScore:            Math.round(brandScore    * 100) / 100,
          niSuitabilityPreScore:    Math.round(niScore       * 100) / 100,
          compositeScore:           Math.round(compositeScore * 100) / 100,
          scoringFactors:           scoringFactors as unknown as Record<string, unknown>,
          generatedAt:              new Date(),
        })
        .onConflictDoUpdate({
          target: [opportunityScores.category, opportunityScores.countryCode],
          targetWhere: isNull(opportunityScores.brandId),
          set: {
            brandId:                  null,
            categoryOpportunityScore: Math.round(categoryScore * 100) / 100,
            brandFitScore:            Math.round(brandScore    * 100) / 100,
            niSuitabilityPreScore:    Math.round(niScore       * 100) / 100,
            compositeScore:           Math.round(compositeScore * 100) / 100,
            scoringFactors:           scoringFactors as unknown as Record<string, unknown>,
            generatedAt:              new Date(),
          },
        });

      upsertedIds.push(rowId);
      scoredRows.push({
        category:       corridor.category,
        countryCode:    corridor.countryCode,
        compositeScore: Math.round(compositeScore * 100) / 100,
      });
    }

    // ── Build result summary ────────────────────────────────────────────────

    const above80 = scoredRows.filter(r => r.compositeScore >= 80).length;
    const above70 = scoredRows.filter(r => r.compositeScore >= 70).length;

    const topCorridors = [...scoredRows]
      .sort((a, b) => b.compositeScore - a.compositeScore)
      .slice(0, 10);

    const result: CompositeScoringResult = {
      corridorsScored: scoredRows.length,
      above80,
      above70,
      topCorridors,
    };

    // ── Persist agent output ────────────────────────────────────────────────

    await db.insert(agentOutputs).values({
      agentType: 'composite_scoring',
      outputData: {
        runAt:           new Date().toISOString(),
        corridorsScored: result.corridorsScored,
        above80:         result.above80,
        above70:         result.above70,
        topCorridors:    result.topCorridors,
      } as unknown as Record<string, unknown>,
      relatedEntityIds: upsertedIds,
    });

    logger.info(
      {
        agent: 'CompositeScoringAgent',
        corridorsScored: result.corridorsScored,
        above80,
        above70,
      },
      'Composite scoring run complete',
    );

    return result;
  }
}
