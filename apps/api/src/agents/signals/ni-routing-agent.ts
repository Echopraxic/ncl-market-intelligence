// src/agents/signals/ni-routing-agent.ts
//
// NIRoutingAgent — Phase 3
//
// Transforms trade flow data into Northern Ireland routing intelligence,
// directly supporting NCL's core competitive advantage as a dual-market
// logistics broker operating under the Windsor Framework.
//
// ── Four detection signals ───────────────────────────────────────────────────
//
//   1. IRISH SEA ROUTING SHIFT
//      Compares growth of US→UK flows against direct US→EU flows in the same
//      HS category.  When us_to_uk YoY growth materially outpaces the average
//      us_to_eu growth across NCL's EU markets, goods are increasingly entering
//      the EU via the UK/NI gateway rather than directly through Rotterdam or
//      Hamburg.  This is the most operationally actionable NI signal — it means
//      the corridor NCL occupies is already carrying growing freight volumes.
//      (Note: Ireland-specific data is unavailable in the current Comtrade fetch
//      scope; us_to_uk vs direct us_to_eu is the more precise proxy for NI
//      routing since NI is part of the UK, not Ireland.)
//
//   2. UK RE-EXPORT ARBITRAGE
//      Measures uk_to_eu re-export volume relative to direct us_to_eu trade in
//      each HS category, and tracks whether that ratio is growing.  A high and
//      rising ratio indicates goods entering the EU via UK re-export — an
//      arbitrage pattern that currently operates in a regulatory grey area but
//      which NCL can legitimise through proper Windsor Framework structuring,
//      turning a compliance risk into a competitive moat.
//
//   3. AIR FREIGHT SUITABILITY
//      Identifies HS categories where the average unit value (USD/kg, already
//      computed by TradeFlowIntelligenceAgent) exceeds $30/kg — the threshold
//      at which air freight economics become competitive with sea freight through
//      major EU ports.  Belfast Airport (BFS) express routing can undercut
//      Rotterdam/Hamburg transit times by 24–48 h for high-value, low-weight
//      categories such as supplements and cosmetics.  This is a category-level
//      signal (euCountry = 'ALL').
//
//   4. DISTRIBUTOR COVERAGE GAP
//      Joins accelerating trade flow series (from tradeFlowIntelligence) with the
//      distributors table.  Where US-to-EU trade is growing strongly but
//      distributor coverage in that (category, EU country) pair is sparse
//      (< 3 distributors importing US goods), NCL has a corridor-broker
//      opportunity to introduce US brands to receptive EU distributors.
//
// ── NI Suitability Pre-Score ─────────────────────────────────────────────────
//   Signals are mapped to the three sub-dimensions defined in scoring-weights.json:
//
//   vatAdvantagePotential (weight 0.40)
//     ← irish_sea_routing + uk_reexport_arb
//     Windsor Framework dual-market access is most valuable when the routing
//     corridor and re-export arbitrage patterns are already present.
//
//   distributionEfficiencyGains (weight 0.30)
//     ← air_freight_suitable + distributor_gap
//     NI express routing efficiency gains are strongest where high-value
//     products exist and incumbent distribution is sparse.
//
//   regulatoryPathwayClarity (weight 0.30)
//     ← inverse of product regulatory complexity (scoring-weights.json lookup)
//     Clearer regulatory pathways enable faster Windsor Framework structuring.
//
//   niSuitabilityPreScore (0–100) = 100 × (0.40×vat + 0.30×dist + 0.30×reg)
//
//   Scores are persisted to opportunityScores with brandId = null (category-level
//   pre-scores) so the future CompositeScoringAgent can join them to brands.

import { db } from '../../db/index.js';
import {
  tradeFlowIntelligence,
  distributors,
  opportunityScores,
  niRoutingSignals,
  agentOutputs,
} from '../../db/schema.js';
import { and, eq, inArray, gte, sql } from 'drizzle-orm';
import { logger } from '../../lib/logger.js';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const scoringWeights = require('../../config/scoring-weights.json');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NCL_EU_MARKETS = ['DE', 'FR', 'NL', 'ES', 'IT', 'GB'] as const;
type EuMarket = typeof NCL_EU_MARKETS[number];

const NCL_CATEGORIES = [
  'food_beverage',
  'supplements',
  'cosmetics_personal_care',
  'home_goods',
  'toys_games',
] as const;
type NclCategory = typeof NCL_CATEGORIES[number];

/**
 * Minimum growth rate threshold (YoY%) before a routing signal is meaningful.
 * Below this, we're looking at noise rather than a structural shift.
 */
const MIN_GROWTH_SIGNAL_PCT = 5;

/**
 * USD/kg threshold above which air freight becomes competitive with sea freight
 * through Rotterdam or Hamburg.  Below this weight-to-value ratio, sea freight
 * economics dominate and NI air routing is unlikely to win on cost.
 */
const AIR_FREIGHT_UNIT_VALUE_THRESHOLD_USD_PER_KG = 30;

/**
 * Minimum normalised us_to_uk vs us_to_eu growth premium (percentage points)
 * to flag a meaningful Irish Sea routing shift.  At 5pp the difference is
 * structural; below that it's within normal annual variation.
 */
const IRISH_SEA_SHIFT_THRESHOLD_PP = 5;

/**
 * Minimum ratio of uk_to_eu trade value to us_to_eu trade value for a
 * re-export arbitrage signal to be meaningful.  10% means at least 10 cents
 * of every $1 of direct US exports is also transiting via UK re-export.
 */
const REEXPORT_MIN_RATIO = 0.10;

/**
 * Distributor coverage threshold — fewer than this many distributors in a
 * (category, country) pair is considered sparse coverage.
 */
const SPARSE_DISTRIBUTOR_THRESHOLD = 3;

/**
 * Regulatory complexity lookup (from scoring-weights.json) keyed by NCL category.
 * Used to derive regulatoryPathwayClarity = 1 − complexity.
 */
const REGULATORY_COMPLEXITY: Record<NclCategory, number> = {
  food_beverage:           0.20,
  supplements:             0.30,
  cosmetics_personal_care: 0.40,
  toys_games:              0.50,
  home_goods:              0.80,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NiSignalRow {
  nclCategory: NclCategory;
  hsChapter: string | null;
  euCountry: string;
  signalType: 'irish_sea_routing' | 'uk_reexport_arb' | 'air_freight_suitable' | 'distributor_gap';
  signalStrength: number;    // 0–1
  niSubDimension: 'vat_advantage' | 'distribution_efficiency' | 'regulatory_clarity';
  evidence: Record<string, unknown>;
}

interface NiSuitabilityScore {
  nclCategory: NclCategory;
  euCountry: string;
  vatAdvantageScore: number;       // 0–1
  distributionEfficiencyScore: number; // 0–1
  regulatoryClarityScore: number;  // 0–1
  niSuitabilityPreScore: number;   // 0–100 composite
  contributingSignals: NiSignalRow[];
}

export interface NiRoutingResult {
  signalsDetected: number;
  signalsByType: Record<string, number>;
  scoresUpserted: number;
  topOpportunities: Array<{
    nclCategory: string;
    euCountry: string;
    niSuitabilityPreScore: number;
    primaryDriver: string;
  }>;
  irishSeaShiftCategories: string[];
  reexportArbitrageCategories: string[];
  airFreightCategories: string[];
  distributorGapPairs: Array<{ category: string; country: string; distributorCount: number }>;
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export class NIRoutingAgent {
  private readonly log = logger.child({ agent: 'NIRoutingAgent' });

  async run(): Promise<NiRoutingResult> {
    this.log.info('[NIRouting] Starting NI routing intelligence run');

    // ── Load trade flow data ──────────────────────────────────────────────────
    const flowRows = await this.loadTradeFlowData();
    this.log.info({ rows: flowRows.length }, '[NIRouting] Trade flow data loaded');

    // ── Load distributor coverage ─────────────────────────────────────────────
    const distributorCoverage = await this.loadDistributorCoverage();
    this.log.info(
      { pairs: distributorCoverage.size },
      '[NIRouting] Distributor coverage loaded',
    );

    // ── Run four detection methods ────────────────────────────────────────────
    const allSignals: NiSignalRow[] = [
      ...this.detectIrishSeaRoutingShift(flowRows),
      ...this.detectUkReexportArbitrage(flowRows),
      ...this.identifyAirFreightCategories(flowRows),
      ...this.detectDistributorCoverageGaps(flowRows, distributorCoverage),
    ];

    this.log.info({ signals: allSignals.length }, '[NIRouting] Signals detected');

    // ── Compute NI suitability pre-scores ─────────────────────────────────────
    const scores = this.computeNiSuitabilityScores(allSignals);

    // ── Persist ───────────────────────────────────────────────────────────────
    await this.persistSignals(allSignals);
    const scoresUpserted = await this.persistScores(scores);

    // ── Build and return result summary ───────────────────────────────────────
    const result = this.buildResult(allSignals, scores, distributorCoverage);

    await db.insert(agentOutputs).values({
      agentType: 'ni_routing_intelligence',
      outputData: {
        runAt: new Date().toISOString(),
        ...result,
      },
      relatedEntityIds: [],
      createdAt: new Date(),
    });

    this.log.info({ scoresUpserted }, '[NIRouting] Run complete');
    return { ...result, scoresUpserted };
  }

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------

  private async loadTradeFlowData(): Promise<TradeFlowRow[]> {
    // Load the most recent year's data (2023) plus 2022 for YoY comparison.
    // We query all 4 flow types in one round-trip.
    const rows = await db
      .select({
        flowType: tradeFlowIntelligence.flowType,
        reporterCountry: tradeFlowIntelligence.reporterCountry,
        partnerCountry: tradeFlowIntelligence.partnerCountry,
        nclCategory: tradeFlowIntelligence.nclCategory,
        hsChapter: tradeFlowIntelligence.hsChapter,
        year: tradeFlowIntelligence.year,
        tradeValueUsd: tradeFlowIntelligence.tradeValueUsd,
        netWeightKg: tradeFlowIntelligence.netWeightKg,
        unitValueUsdPerKg: tradeFlowIntelligence.unitValueUsdPerKg,
        growthRateYoy: tradeFlowIntelligence.growthRateYoy,
      })
      .from(tradeFlowIntelligence)
      .where(inArray(tradeFlowIntelligence.year, [2021, 2022, 2023]));

    return rows as TradeFlowRow[];
  }

  /**
   * Returns Map<"category|countryCode", distributorCount> counting distributors
   * in each (NCL category, EU country) pair who import US goods.
   */
  private async loadDistributorCoverage(): Promise<Map<string, number>> {
    const rows = await db
      .select({
        countryCode: distributors.countryCode,
        categories: distributors.categories,
        importsUsGoods: distributors.importsUsGoods,
      })
      .from(distributors);

    const coverage = new Map<string, number>();

    for (const row of rows) {
      if (!row.importsUsGoods) continue;
      const cats = row.categories ?? [];
      for (const cat of cats) {
        const normCat = this.normaliseCategoryLabel(cat);
        if (!normCat) continue;
        const key = `${normCat}|${row.countryCode}`;
        coverage.set(key, (coverage.get(key) ?? 0) + 1);
      }
    }

    return coverage;
  }

  // ---------------------------------------------------------------------------
  // Signal 1 — Irish Sea Routing Shift
  //
  // Detects when US→UK growth is outpacing direct US→EU growth in the same
  // HS category, indicating the NI gateway corridor is gaining freight share
  // over direct Rotterdam/Hamburg routing.
  //
  // Method:
  //   For each (nclCategory, hsChapter):
  //     us_to_uk_growth   = YoY% of us_to_uk flow (latest year)
  //     avg_us_to_eu_growth = mean YoY% across NCL EU markets for us_to_eu
  //     premium = us_to_uk_growth − avg_us_to_eu_growth
  //
  //   If premium > IRISH_SEA_SHIFT_THRESHOLD_PP AND us_to_uk_growth > 0:
  //     Signal fires.  Strength = clamp((premium − threshold) / 30, 0, 1)
  //     — at 35pp above threshold the signal reaches full strength.
  //
  //   This maps to vatAdvantagePotential: the routing corridor's growing
  //   activity is what makes Windsor Framework dual-market structuring valuable.
  // ---------------------------------------------------------------------------

  private detectIrishSeaRoutingShift(rows: TradeFlowRow[]): NiSignalRow[] {
    const signals: NiSignalRow[] = [];

    // Group latest-year rows by category+chapter for each flow type
    const year2023 = rows.filter(r => r.year === 2023);

    const usToUkByCategory = this.groupBy(
      year2023.filter(r => r.flowType === 'us_to_uk'),
      r => `${r.nclCategory}|${r.hsChapter}`,
    );

    const usToEuByCategory = this.groupBy(
      year2023.filter(r => r.flowType === 'us_to_eu'),
      r => `${r.nclCategory}|${r.hsChapter}`,
    );

    for (const [key, ukRows] of usToUkByCategory.entries()) {
      const [nclCategory, hsChapter] = key.split('|') as [NclCategory, string];
      const euRows = usToEuByCategory.get(key) ?? [];

      // us_to_uk growth: average across all UK rows for this chapter
      const ukGrowths = ukRows
        .map(r => r.growthRateYoy)
        .filter((g): g is number => g != null);
      if (ukGrowths.length === 0) continue;
      const usToUkGrowth = avg(ukGrowths);

      // Average us_to_eu growth across the 5 mainland EU markets (exclude GB)
      const euGrowths = euRows
        .filter(r => r.partnerCountry !== 'GB')
        .map(r => r.growthRateYoy)
        .filter((g): g is number => g != null);
      const avgUsToEuGrowth = euGrowths.length > 0 ? avg(euGrowths) : 0;

      const premium = usToUkGrowth - avgUsToEuGrowth;

      if (premium < IRISH_SEA_SHIFT_THRESHOLD_PP || usToUkGrowth < MIN_GROWTH_SIGNAL_PCT) {
        continue;
      }

      // Normalise: 5pp premium → 0.0, 35pp premium → 1.0
      const signalStrength = clamp((premium - IRISH_SEA_SHIFT_THRESHOLD_PP) / 30, 0, 1);

      // uk_to_eu value for this category (corroborating evidence that goods
      // entering UK are being re-exported to EU, not consumed domestically)
      const ukToEuValue2023 = sum(
        rows
          .filter(r => r.year === 2023 && r.flowType === 'uk_to_eu'
            && r.nclCategory === nclCategory && r.hsChapter === hsChapter)
          .map(r => r.tradeValueUsd ?? 0),
      );

      signals.push({
        nclCategory,
        hsChapter,
        euCountry: 'ALL',
        signalType: 'irish_sea_routing',
        signalStrength,
        niSubDimension: 'vat_advantage',
        evidence: {
          usToUkGrowthPct: round2(usToUkGrowth),
          avgUsToEuGrowthPct: round2(avgUsToEuGrowth),
          premiumPp: round2(premium),
          ukToEuTradeValue2023Usd: round2(ukToEuValue2023),
          year: 2023,
          interpretation: 'US goods entering EU via UK/NI gateway at accelerating rate '
            + 'relative to direct EU routing — NI corridor is gaining freight share.',
        },
      });
    }

    this.log.info(
      { count: signals.length },
      '[NIRouting] Irish Sea routing shift signals detected',
    );
    return signals;
  }

  // ---------------------------------------------------------------------------
  // Signal 2 — UK Re-export Arbitrage
  //
  // Quantifies re-export activity per (category, EU country), flags where the
  // ratio of uk_to_eu value to us_to_eu value is significant and growing.
  //
  // Method:
  //   For each (nclCategory, euCountry):
  //     ratio_2023 = uk_to_eu_value_2023 / us_to_eu_value_2023
  //     ratio_2021 = uk_to_eu_value_2021 / us_to_eu_value_2021
  //     ratio_growth = ratio_2023 − ratio_2021
  //
  //   If ratio_2023 > REEXPORT_MIN_RATIO:
  //     Signal fires.  Strength = clamp(ratio_2023 / 0.5, 0, 1)
  //     — when re-export = 50% of direct trade the signal is at full strength.
  //     Growing ratio adds 20% boost (ratio_growth > 0).
  //
  //   Maps to vatAdvantagePotential: Windsor Framework structuring turns this
  //   grey-area re-export flow into a compliant NI dual-market operation.
  // ---------------------------------------------------------------------------

  private detectUkReexportArbitrage(rows: TradeFlowRow[]): NiSignalRow[] {
    const signals: NiSignalRow[] = [];

    for (const euCountry of NCL_EU_MARKETS) {
      for (const nclCategory of NCL_CATEGORIES) {
        const usToEu2023 = this.tradeValue(rows, 'us_to_eu', 'US', euCountry, nclCategory, 2023);
        const ukToEu2023 = this.tradeValue(rows, 'uk_to_eu', 'GB', euCountry, nclCategory, 2023);
        const usToEu2021 = this.tradeValue(rows, 'us_to_eu', 'US', euCountry, nclCategory, 2021);
        const ukToEu2021 = this.tradeValue(rows, 'uk_to_eu', 'GB', euCountry, nclCategory, 2021);

        if (usToEu2023 === 0 || ukToEu2023 === 0) continue;

        const ratio2023 = ukToEu2023 / usToEu2023;
        const ratio2021 = usToEu2021 > 0 && ukToEu2021 > 0
          ? ukToEu2021 / usToEu2021
          : null;

        if (ratio2023 < REEXPORT_MIN_RATIO) continue;

        const ratioGrowth = ratio2021 != null ? ratio2023 - ratio2021 : null;
        const isGrowing = ratioGrowth != null && ratioGrowth > 0;

        // Strength: 10% ratio → 0.20, 50% ratio → 1.0; growing ratio adds 20% boost
        let signalStrength = clamp(ratio2023 / 0.5, 0, 1);
        if (isGrowing) signalStrength = clamp(signalStrength * 1.2, 0, 1);

        signals.push({
          nclCategory,
          hsChapter: null,
          euCountry,
          signalType: 'uk_reexport_arb',
          signalStrength,
          niSubDimension: 'vat_advantage',
          evidence: {
            ukToEuValue2023Usd: round2(ukToEu2023),
            usToEuValue2023Usd: round2(usToEu2023),
            reexportRatio2023: round2(ratio2023),
            reexportRatio2021: ratio2021 != null ? round2(ratio2021) : null,
            ratioGrowth: ratioGrowth != null ? round2(ratioGrowth) : null,
            isGrowing,
            interpretation: 'UK re-exports to this EU market represent '
              + `${(ratio2023 * 100).toFixed(1)}% of direct US imports — `
              + 'Windsor Framework structuring via NI could legitimise this corridor.',
          },
        });
      }
    }

    this.log.info(
      { count: signals.length },
      '[NIRouting] UK re-export arbitrage signals detected',
    );
    return signals;
  }

  // ---------------------------------------------------------------------------
  // Signal 3 — Air Freight Suitability
  //
  // Identifies HS categories where average unit value (USD/kg) exceeds the
  // threshold at which NI air express routing undercuts sea freight transit time.
  //
  // Method:
  //   For each (nclCategory, hsChapter):
  //     avgUnitValue = mean(unitValueUsdPerKg) across all years and EU markets
  //
  //   If avgUnitValue > AIR_FREIGHT_UNIT_VALUE_THRESHOLD_USD_PER_KG:
  //     Signal fires as a category-wide signal (euCountry = 'ALL').
  //     Strength = clamp((avgUnitValue − threshold) / (threshold × 4), 0, 1)
  //     — at 5× threshold (e.g. $150/kg for supplements) signal reaches 1.0.
  //
  //   Maps to distributionEfficiencyGains: Belfast Airport express routing
  //   delivers 24–48h advantage over Rotterdam/Hamburg for these categories.
  // ---------------------------------------------------------------------------

  private identifyAirFreightCategories(rows: TradeFlowRow[]): NiSignalRow[] {
    const signals: NiSignalRow[] = [];

    const usToEuRows = rows.filter(r => r.flowType === 'us_to_eu');
    const byChapter = this.groupBy(
      usToEuRows.filter(r => r.unitValueUsdPerKg != null && r.unitValueUsdPerKg > 0),
      r => `${r.nclCategory}|${r.hsChapter}`,
    );

    for (const [key, chapterRows] of byChapter.entries()) {
      const [nclCategory, hsChapter] = key.split('|') as [NclCategory, string];

      const unitValues = chapterRows
        .map(r => r.unitValueUsdPerKg!)
        .filter(v => v > 0 && v < 100_000); // cap absurd outliers

      if (unitValues.length === 0) continue;

      const avgUnitValue = avg(unitValues);
      const maxUnitValue = Math.max(...unitValues);

      if (avgUnitValue < AIR_FREIGHT_UNIT_VALUE_THRESHOLD_USD_PER_KG) continue;

      // Normalise: threshold ($30/kg) → 0.0, 5× threshold ($150/kg) → 1.0
      const signalStrength = clamp(
        (avgUnitValue - AIR_FREIGHT_UNIT_VALUE_THRESHOLD_USD_PER_KG)
          / (AIR_FREIGHT_UNIT_VALUE_THRESHOLD_USD_PER_KG * 4),
        0,
        1,
      );

      // Total trade value for sizing context
      const totalUsd2023 = sum(
        chapterRows.filter(r => r.year === 2023).map(r => r.tradeValueUsd ?? 0),
      );

      signals.push({
        nclCategory,
        hsChapter,
        euCountry: 'ALL',
        signalType: 'air_freight_suitable',
        signalStrength,
        niSubDimension: 'distribution_efficiency',
        evidence: {
          avgUnitValueUsdPerKg: round2(avgUnitValue),
          maxUnitValueUsdPerKg: round2(maxUnitValue),
          thresholdUsdPerKg: AIR_FREIGHT_UNIT_VALUE_THRESHOLD_USD_PER_KG,
          totalTradeValue2023Usd: round2(totalUsd2023),
          sampleSize: unitValues.length,
          interpretation: `Avg unit value $${avgUnitValue.toFixed(1)}/kg exceeds `
            + `$${AIR_FREIGHT_UNIT_VALUE_THRESHOLD_USD_PER_KG}/kg threshold. `
            + 'Belfast Airport (BFS) air express routing is cost-competitive '
            + 'with Rotterdam/Hamburg sea freight for this category.',
        },
      });
    }

    this.log.info(
      { count: signals.length },
      '[NIRouting] Air freight suitability signals detected',
    );
    return signals;
  }

  // ---------------------------------------------------------------------------
  // Signal 4 — Distributor Coverage Gap
  //
  // Flags (category, EU country) pairs where US-to-EU trade is growing strongly
  // but the distributor table shows sparse coverage — indicating NCL has an
  // opportunity to broker new distributor partnerships in that corridor.
  //
  // Method:
  //   For each (nclCategory, euCountry):
  //     distributorCount = distributors in that country carrying that category
  //                        who import US goods
  //     usToEuGrowth_2023 = YoY% for us_to_eu flow in this category+country
  //
  //   If distributorCount < SPARSE_DISTRIBUTOR_THRESHOLD
  //      AND usToEuGrowth_2023 > MIN_GROWTH_SIGNAL_PCT:
  //     Signal fires.  Strength = growth_factor × coverage_gap_factor
  //       growth_factor = clamp(usToEuGrowth / 50, 0, 1)  (50% growth → 1.0)
  //       coverage_gap_factor = 1 − (distributorCount / SPARSE_DISTRIBUTOR_THRESHOLD)
  //         (0 distributors → 1.0, 2 distributors → 0.33)
  //
  //   Maps to distributionEfficiencyGains: NCL can directly address this gap
  //   by brokering introductions between US brands and EU distributors.
  // ---------------------------------------------------------------------------

  private detectDistributorCoverageGaps(
    rows: TradeFlowRow[],
    coverage: Map<string, number>,
  ): NiSignalRow[] {
    const signals: NiSignalRow[] = [];

    for (const euCountry of NCL_EU_MARKETS) {
      for (const nclCategory of NCL_CATEGORIES) {
        const coverageKey = `${nclCategory}|${euCountry}`;
        const distributorCount = coverage.get(coverageKey) ?? 0;

        if (distributorCount >= SPARSE_DISTRIBUTOR_THRESHOLD) continue;

        // Aggregate YoY growth for us_to_eu in this category+country for 2023
        const growthValues = rows
          .filter(r =>
            r.flowType === 'us_to_eu'
            && r.partnerCountry === euCountry
            && r.nclCategory === nclCategory
            && r.year === 2023
            && r.growthRateYoy != null,
          )
          .map(r => r.growthRateYoy!);

        if (growthValues.length === 0) continue;

        const avgGrowth = avg(growthValues);
        if (avgGrowth < MIN_GROWTH_SIGNAL_PCT) continue;

        const growthFactor = clamp(avgGrowth / 50, 0, 1);
        const coverageGapFactor = 1 - (distributorCount / SPARSE_DISTRIBUTOR_THRESHOLD);
        const signalStrength = clamp(growthFactor * coverageGapFactor, 0, 1);

        // Trade value context
        const tradeValue2023 = this.tradeValue(rows, 'us_to_eu', 'US', euCountry, nclCategory, 2023);

        signals.push({
          nclCategory,
          hsChapter: null,
          euCountry,
          signalType: 'distributor_gap',
          signalStrength,
          niSubDimension: 'distribution_efficiency',
          evidence: {
            distributorCount,
            sparseThreshold: SPARSE_DISTRIBUTOR_THRESHOLD,
            usToEuGrowthPct: round2(avgGrowth),
            tradeValue2023Usd: round2(tradeValue2023),
            interpretation: `Only ${distributorCount} US-goods importer(s) in ${euCountry} `
              + `carry ${nclCategory} — despite ${avgGrowth.toFixed(1)}% YoY trade growth. `
              + 'NCL can broker new distributor partnerships in this corridor.',
          },
        });
      }
    }

    this.log.info(
      { count: signals.length },
      '[NIRouting] Distributor gap signals detected',
    );
    return signals;
  }

  // ---------------------------------------------------------------------------
  // NI Suitability Pre-Score Computation
  //
  // Aggregates individual signals into the three sub-dimensions defined in
  // scoring-weights.json, then computes the weighted composite score.
  //
  // Sub-dimension scores are the max signal strength across all contributing
  // signals in that dimension for the (category, country) pair, not the mean.
  // Max is appropriate here: the strongest routing advantage in a category
  // defines its ceiling opportunity, not the average across weak signals.
  // ---------------------------------------------------------------------------

  private computeNiSuitabilityScores(signals: NiSignalRow[]): NiSuitabilityScore[] {
    const scores: NiSuitabilityScore[] = [];

    for (const euCountry of NCL_EU_MARKETS) {
      for (const nclCategory of NCL_CATEGORIES) {
        // Collect signals relevant to this (category, country):
        // - Country-specific signals match exactly
        // - Category-wide signals (euCountry = 'ALL') apply to every country
        const relevant = signals.filter(
          s => s.nclCategory === nclCategory
            && (s.euCountry === euCountry || s.euCountry === 'ALL'),
        );

        if (relevant.length === 0) continue;

        // ── vatAdvantagePotential ─────────────────────────────────────────────
        // Driven by irish_sea_routing and uk_reexport_arb signals
        const vatSignals = relevant.filter(s => s.niSubDimension === 'vat_advantage');
        const vatAdvantageScore = vatSignals.length > 0
          ? Math.max(...vatSignals.map(s => s.signalStrength))
          : 0;

        // ── distributionEfficiencyGains ───────────────────────────────────────
        // Driven by air_freight_suitable and distributor_gap signals
        const distSignals = relevant.filter(s => s.niSubDimension === 'distribution_efficiency');
        const distributionEfficiencyScore = distSignals.length > 0
          ? Math.max(...distSignals.map(s => s.signalStrength))
          : 0;

        // ── regulatoryPathwayClarity ──────────────────────────────────────────
        // Static per category — inverse of complexity from scoring-weights.json.
        // Lower regulatory complexity = clearer NI Windsor Framework pathway.
        const complexity = REGULATORY_COMPLEXITY[nclCategory] ?? 0.5;
        const regulatoryClarityScore = 1 - complexity;

        // Only compute a score if at least one dynamic signal fired
        if (vatAdvantageScore === 0 && distributionEfficiencyScore === 0) continue;

        // Composite: 0.40 × vat + 0.30 × dist + 0.30 × reg
        const niSuitabilityPreScore = round2(
          100 * (
            0.40 * vatAdvantageScore
            + 0.30 * distributionEfficiencyScore
            + 0.30 * regulatoryClarityScore
          ),
        );

        scores.push({
          nclCategory,
          euCountry,
          vatAdvantageScore,
          distributionEfficiencyScore,
          regulatoryClarityScore,
          niSuitabilityPreScore,
          contributingSignals: relevant,
        });
      }
    }

    return scores.sort((a, b) => b.niSuitabilityPreScore - a.niSuitabilityPreScore);
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  private async persistSignals(signals: NiSignalRow[]): Promise<void> {
    if (signals.length === 0) return;

    // Batch insert — replace existing signals for this run (no upsert key needed;
    // signals are append-only; the dashboard query uses computedAt to get latest)
    const batchSize = 50;
    for (let i = 0; i < signals.length; i += batchSize) {
      const batch = signals.slice(i, i + batchSize);
      try {
        await db.insert(niRoutingSignals).values(
          batch.map(s => ({
            id: randomUUID(),
            nclCategory: s.nclCategory,
            hsChapter: s.hsChapter,
            euCountry: s.euCountry,
            signalType: s.signalType,
            signalStrength: s.signalStrength,
            niSubDimension: s.niSubDimension,
            evidence: s.evidence,
            computedAt: new Date(),
          })),
        );
      } catch (err) {
        this.log.warn(
          { err: err instanceof Error ? err.message : String(err), batchStart: i },
          '[NIRouting] Signal batch insert failed',
        );
      }
    }
  }

  private async persistScores(scores: NiSuitabilityScore[]): Promise<number> {
    let upserted = 0;

    for (const score of scores) {
      try {
        // Upsert into opportunityScores with brandId = null (category-level pre-score).
        // The CompositeScoringAgent (Phase 3) will later join these to specific brands.
        await db
          .insert(opportunityScores)
          .values({
            id: randomUUID(),
            brandId: null,
            category: score.nclCategory,
            countryCode: score.euCountry,
            categoryOpportunityScore: 0,  // populated by CompositeScoringAgent
            brandFitScore: 0,             // populated by CompositeScoringAgent
            niSuitabilityPreScore: score.niSuitabilityPreScore,
            compositeScore: 0,            // populated by CompositeScoringAgent
            scoringFactors: {
              vatAdvantageScore: round2(score.vatAdvantageScore),
              distributionEfficiencyScore: round2(score.distributionEfficiencyScore),
              regulatoryClarityScore: round2(score.regulatoryClarityScore),
              signalCount: score.contributingSignals.length,
              signalTypes: [...new Set(score.contributingSignals.map(s => s.signalType))],
              generatedBy: 'NIRoutingAgent',
            },
            generatedAt: new Date(),
          })
          .onConflictDoNothing(); // if same category+country exists, keep it — CompositeScoringAgent will reconcile

        upserted++;
      } catch (err) {
        this.log.warn(
          {
            category: score.nclCategory,
            country: score.euCountry,
            err: err instanceof Error ? err.message : String(err),
          },
          '[NIRouting] Score upsert failed',
        );
      }
    }

    return upserted;
  }

  // ---------------------------------------------------------------------------
  // Result summary
  // ---------------------------------------------------------------------------

  private buildResult(
    signals: NiSignalRow[],
    scores: NiSuitabilityScore[],
    coverage: Map<string, number>,
  ): Omit<NiRoutingResult, 'scoresUpserted'> {
    const byType = signals.reduce<Record<string, number>>((acc, s) => {
      acc[s.signalType] = (acc[s.signalType] ?? 0) + 1;
      return acc;
    }, {});

    const irishSeaShiftCategories = [
      ...new Set(
        signals.filter(s => s.signalType === 'irish_sea_routing').map(s => s.nclCategory),
      ),
    ];

    const reexportArbitrageCategories = [
      ...new Set(
        signals.filter(s => s.signalType === 'uk_reexport_arb').map(s => s.nclCategory),
      ),
    ];

    const airFreightCategories = [
      ...new Set(
        signals.filter(s => s.signalType === 'air_freight_suitable').map(s => s.nclCategory),
      ),
    ];

    const distributorGapPairs = signals
      .filter(s => s.signalType === 'distributor_gap')
      .map(s => ({
        category: s.nclCategory,
        country: s.euCountry,
        distributorCount: (s.evidence['distributorCount'] as number) ?? 0,
      }))
      .sort((a, b) => a.distributorCount - b.distributorCount);

    const topOpportunities = scores.slice(0, 10).map(sc => {
      // Identify primary driver (highest sub-dimension)
      const dims = [
        { name: 'vatAdvantagePotential', score: sc.vatAdvantageScore },
        { name: 'distributionEfficiencyGains', score: sc.distributionEfficiencyScore },
        { name: 'regulatoryPathwayClarity', score: sc.regulatoryClarityScore },
      ];
      const primaryDriver = dims.sort((a, b) => b.score - a.score)[0]!.name;

      return {
        nclCategory: sc.nclCategory,
        euCountry: sc.euCountry,
        niSuitabilityPreScore: sc.niSuitabilityPreScore,
        primaryDriver,
      };
    });

    return {
      signalsDetected: signals.length,
      signalsByType: byType,
      topOpportunities,
      irishSeaShiftCategories,
      reexportArbitrageCategories,
      airFreightCategories,
      distributorGapPairs,
    };
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  /** Sum trade values for a specific (flowType, reporter, partner, category, year) combination. */
  private tradeValue(
    rows: TradeFlowRow[],
    flowType: string,
    reporter: string,
    partner: string,
    nclCategory: string,
    year: number,
  ): number {
    return sum(
      rows
        .filter(
          r => r.flowType === flowType
            && r.reporterCountry === reporter
            && r.partnerCountry === partner
            && r.nclCategory === nclCategory
            && r.year === year,
        )
        .map(r => r.tradeValueUsd ?? 0),
    );
  }

  private groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
    const map = new Map<string, T[]>();
    for (const item of items) {
      const k = key(item);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(item);
    }
    return map;
  }

  /**
   * Normalises free-text distributor category labels to NCL canonical categories.
   * Distributors may use labels like "Food & Beverage" or "food_beverage".
   */
  private normaliseCategoryLabel(label: string): NclCategory | null {
    const lower = label.toLowerCase().replace(/[^a-z]/g, '_');
    if (lower.includes('food') || lower.includes('beverage')) return 'food_beverage';
    if (lower.includes('supplement') || lower.includes('health') || lower.includes('wellness')) return 'supplements';
    if (lower.includes('cosmetic') || lower.includes('beauty') || lower.includes('personal')) return 'cosmetics_personal_care';
    if (lower.includes('home') || lower.includes('living') || lower.includes('houseware')) return 'home_goods';
    if (lower.includes('toy') || lower.includes('game')) return 'toys_games';
    return null;
  }
}

// ---------------------------------------------------------------------------
// Internal type (rows loaded from DB)
// ---------------------------------------------------------------------------

interface TradeFlowRow {
  flowType: string;
  reporterCountry: string;
  partnerCountry: string;
  nclCategory: string;
  hsChapter: string;
  year: number;
  tradeValueUsd: number | null;
  netWeightKg: number | null;
  unitValueUsdPerKg: number | null;
  growthRateYoy: number | null;
}

// ---------------------------------------------------------------------------
// Numeric helpers
// ---------------------------------------------------------------------------

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
