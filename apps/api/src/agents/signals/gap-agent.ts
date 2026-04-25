// src/agents/signals/gap-agent.ts
//
// DemandSupplyGapAgent — Option B (percentile-normalised scoring)
//
// For each (category, countryCode) pair found in the active trends window it:
//   1. Fetches raw metrics:
//        demand_signal   = 0.6 × norm(growthRate) + 0.4 × norm(avgSignalStrength)
//        import_reliance = US imports / total world imports (from TradeFlowClient)
//        local_brand_density = count of distinct brands carried by distributors
//                              in that category + country
//   2. Percentile-ranks each component across ALL pairs in the current batch.
//   3. Computes gap_score = 100 × (0.40×demand_pct + 0.35×import_pct + 0.25×(1−density_pct))
//      Higher score → larger uncaptured opportunity.
//   4. Persists results to gap_scores and agent_outputs tables.
//
// Triggered by TrendDetectionScheduler.runWeeklyDetection() after trend processing.

import { db } from '../../db/index.js';
import {
  euMarketSignals,
  trends,
  distributors,
  gapScores,
  agentOutputs,
} from '../../db/schema.js';
import { and, eq, gte, desc, sql } from 'drizzle-orm';
import { TradeFlowClient } from '../../lib/trade-flow-client.js';
import { logger } from '../../lib/logger.js';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RawMetrics {
  category: string;
  countryCode: string;
  trendId: string;
  growthRate: number;
  avgSignalStrength: number;   // 0–100 from eu_market_signals.signal_value
  localBrandDensity: number;   // raw count
  importReliance: number;      // 0–1
  importSource: string;
}

export interface GapScoreOutput {
  category: string;
  countryCode: string;
  trendId: string;
  demandSignal: number;
  importReliance: number;
  localBrandDensity: number;
  demandPercentile: number;
  importPercentile: number;
  densityPercentile: number;
  gapScore: number;
}

export interface GapRunResult {
  scored: number;
  topGaps: GapScoreOutput[];
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export class DemandSupplyGapAgent {
  private readonly tradeFlow = new TradeFlowClient();

  /**
   * Run gap scoring for all active trends (past 90 days).
   * Pass trendIds to restrict to a specific subset (used by TrendScheduler).
   */
  async run(trendIds?: string[]): Promise<GapRunResult> {
    logger.info('[GapAgent] Starting demand-supply gap scoring run');

    // -----------------------------------------------------------------------
    // 1. Fetch trending (category, country) pairs from active trends
    // -----------------------------------------------------------------------

    const windowStart = new Date();
    windowStart.setDate(windowStart.getDate() - 90);

    const trendRows = await db
      .select({
        id: trends.id,
        category: trends.category,
        countryCode: trends.countryCode,
        growthRate: trends.growthRate,
      })
      .from(trends)
      .where(
        and(
          gte(trends.createdAt, windowStart),
          ...(trendIds && trendIds.length > 0
            ? [sql`${trends.id} = ANY(${sql`ARRAY[${sql.join(trendIds.map(id => sql`${id}::uuid`), sql`, `)}]`})`]
            : []),
        ),
      )
      .orderBy(desc(trends.growthRate))
      .limit(200);

    if (trendRows.length === 0) {
      logger.info('[GapAgent] No active trends found — nothing to score');
      return { scored: 0, topGaps: [] };
    }

    // -----------------------------------------------------------------------
    // 2. Fetch average signal strength per (category, country) from raw signals
    // -----------------------------------------------------------------------

    const signalMap = new Map<string, number>();
    for (const row of trendRows) {
      const key = `${row.countryCode}:${row.category}`;
      if (signalMap.has(key)) continue;

      const [agg] = await db
        .select({ avg: sql<number>`avg(${euMarketSignals.signalValue})` })
        .from(euMarketSignals)
        .where(
          and(
            eq(euMarketSignals.countryCode, row.countryCode),
            eq(euMarketSignals.category, row.category),
            gte(euMarketSignals.capturedAt, windowStart),
          ),
        );

      signalMap.set(key, agg?.avg ?? 0);
    }

    // -----------------------------------------------------------------------
    // 3. Fetch local brand density per (category, country) from distributors
    //    density = count of distinct brands in distributors.brands_carried
    //              for distributors operating in that category + country
    // -----------------------------------------------------------------------

    const densityMap = new Map<string, number>();
    const uniquePairs = [...new Set(trendRows.map(r => `${r.countryCode}:${r.category}`))];

    for (const pair of uniquePairs) {
      const [countryCode, ...catParts] = pair.split(':');
      const category = catParts.join(':');

      // Count distinct brands carried by distributors in this country that
      // list this category. We use the array overlap operator via raw SQL.
      const [result] = await db
        .select({
          distinctBrands: sql<number>`
            count(distinct brand)
            from (
              select unnest(${distributors.brandsCarried}) as brand
              from ${distributors}
              where ${distributors.countryCode} = ${countryCode}
                and ${distributors.categories} @> ARRAY[${category}]
            ) sub
          `.as('sub'),
        })
        .from(distributors)
        .where(
          and(
            eq(distributors.countryCode, countryCode),
            sql`${distributors.categories} @> ARRAY[${category}]`,
          ),
        )
        .limit(1);

      densityMap.set(pair, Number(result?.distinctBrands ?? 0));
    }

    // -----------------------------------------------------------------------
    // 4. Fetch import reliance for all pairs via TradeFlowClient
    // -----------------------------------------------------------------------

    const pairs = trendRows.map(r => ({ category: r.category, countryCode: r.countryCode }));
    const importData = await this.tradeFlow.fetchImportReliance(pairs);

    // -----------------------------------------------------------------------
    // 5. Assemble raw metrics matrix
    // -----------------------------------------------------------------------

    const rawMatrix: RawMetrics[] = trendRows.map(row => {
      const pairKey = `${row.countryCode}:${row.category}`;
      const imp = importData.get(pairKey);
      return {
        category: row.category,
        countryCode: row.countryCode,
        trendId: row.id,
        growthRate: row.growthRate,
        avgSignalStrength: signalMap.get(pairKey) ?? 0,
        localBrandDensity: densityMap.get(pairKey) ?? 0,
        importReliance: imp?.importReliance ?? 0.30,
        importSource: imp?.source ?? 'fallback',
      };
    });

    // -----------------------------------------------------------------------
    // 6. Min-max normalise growthRate and signalStrength within batch,
    //    then compute combined demand_signal (0–1)
    // -----------------------------------------------------------------------

    const growthRates = rawMatrix.map(m => m.growthRate);
    const signals = rawMatrix.map(m => m.avgSignalStrength);

    const normGrowth = minMaxNorm(growthRates);
    const normSignal = minMaxNorm(signals);

    const withDemand = rawMatrix.map((m, i) => ({
      ...m,
      demandSignal: 0.6 * normGrowth[i] + 0.4 * (normSignal[i] ?? 0),
    }));

    // -----------------------------------------------------------------------
    // 7. Percentile-rank each component across all pairs
    // -----------------------------------------------------------------------

    const demandValues = withDemand.map(m => m.demandSignal);
    const importValues = withDemand.map(m => m.importReliance);
    const densityValues = withDemand.map(m => m.localBrandDensity);

    const scored: GapScoreOutput[] = withDemand.map((m, i) => {
      const demandPct = percentileRank(demandValues, demandValues[i]);
      const importPct = percentileRank(importValues, importValues[i]);
      const densityPct = percentileRank(densityValues, densityValues[i]);

      // Higher demand + higher import reliance + LOWER density = higher gap score
      const gapScore =
        100 * (0.40 * demandPct + 0.35 * importPct + 0.25 * (1 - densityPct));

      return {
        category: m.category,
        countryCode: m.countryCode,
        trendId: m.trendId,
        demandSignal: m.demandSignal,
        importReliance: m.importReliance,
        localBrandDensity: m.localBrandDensity,
        demandPercentile: demandPct,
        importPercentile: importPct,
        densityPercentile: densityPct,
        gapScore: Math.round(gapScore * 10) / 10,
      };
    });

    // -----------------------------------------------------------------------
    // 8. Persist to gap_scores and agent_outputs
    // -----------------------------------------------------------------------

    await this.persist(scored, rawMatrix);

    const topGaps = [...scored].sort((a, b) => b.gapScore - a.gapScore).slice(0, 10);

    logger.info(
      { scored: scored.length, topScore: topGaps[0]?.gapScore },
      '[GapAgent] Gap scoring complete',
    );

    return { scored: scored.length, topGaps };
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async persist(scored: GapScoreOutput[], rawMatrix: RawMetrics[]): Promise<void> {
    const rawByKey = new Map(rawMatrix.map(m => [`${m.countryCode}:${m.category}`, m]));

    for (const score of scored) {
      const raw = rawByKey.get(`${score.countryCode}:${score.category}`);

      try {
        await db.insert(gapScores).values({
          id: randomUUID(),
          category: score.category,
          countryCode: score.countryCode,
          trendId: score.trendId,
          demandSignal: score.demandSignal,
          importReliance: score.importReliance,
          localBrandDensity: score.localBrandDensity,
          demandPercentile: score.demandPercentile,
          importPercentile: score.importPercentile,
          densityPercentile: score.densityPercentile,
          gapScore: score.gapScore,
          scoringFactors: {
            importSource: raw?.importSource,
            growthRate: raw?.growthRate,
            avgSignalStrength: raw?.avgSignalStrength,
          },
          generatedAt: new Date(),
        });
      } catch (err) {
        logger.warn(
          { category: score.category, countryCode: score.countryCode, err },
          '[GapAgent] Failed to insert gap score row',
        );
      }
    }

    // Summary entry in agent_outputs for audit trail
    await db.insert(agentOutputs).values({
      agentType: 'demand_supply_gap',
      outputData: {
        runAt: new Date().toISOString(),
        pairsScored: scored.length,
        topGaps: scored
          .sort((a, b) => b.gapScore - a.gapScore)
          .slice(0, 20)
          .map(s => ({
            category: s.category,
            countryCode: s.countryCode,
            gapScore: s.gapScore,
          })),
      },
      relatedEntityIds: scored.map(s => s.trendId),
      createdAt: new Date(),
    });
  }
}

// ---------------------------------------------------------------------------
// Statistical helpers
// ---------------------------------------------------------------------------

/** Min-max normalise an array to [0, 1]. All-same values → 0.5. */
function minMaxNorm(values: number[]): number[] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 0.5);
  return values.map(v => (v - min) / (max - min));
}

/**
 * Fraction of values in the array that are strictly less than `value`.
 * Returns 0 for the minimum, approaches 1 for the maximum.
 * Ties share the same percentile (their rank is based on values below them).
 */
function percentileRank(values: number[], value: number): number {
  if (values.length <= 1) return 0.5;
  const below = values.filter(v => v < value).length;
  return below / (values.length - 1);
}
