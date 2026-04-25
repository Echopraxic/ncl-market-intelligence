// src/agents/signals/cross-signal-correlation-agent.ts
//
// CrossSignalCorrelationAgent
//
// Synthesises intelligence across the full Market Intelligence Engine pipeline
// by computing three classes of cross-signal correlation for each active
// (category, countryCode) pair sourced from trade_flow_analytics:
//
//   1. RETAILER LEAD-LAG
//      Compares monthly retailer_activities surge timing against monthly
//      trade_flow_monthly spikes to determine whether EU retailer new-listing
//      activity is a leading or lagging indicator for US trade flow momentum.
//      Leading retail = early-entry window; lagging = market pull confirmed.
//
//   2. TRADE SHOW TARGETING
//      Cross-references accelerating HS categories against upcoming trade_shows
//      to surface high-propensity intercept windows where NCL can engage brands
//      already committed to EU expansion.
//
//   3. DISTRIBUTOR COVERAGE GAP
//      Compares trade flow growth rates against distributor density per
//      (category, countryCode) to expose underserved corridors where NCL
//      broker relationships would fill critical distribution infrastructure.
//
// Output is stored in opportunity_correlations as structured JSONB with
// evidence arrays, enabling CompositeScoringAgent and InsightGenerationAgent
// to construct multi-factor opportunity narratives.

import { db } from '../../db/index.js';
import {
  tradeFlowAnalytics,
  tradeFlowMonthly,
  retailerActivities,
  tradeShows,
  distributors,
  trends,
  agentOutputs,
  opportunityCorrelations,
} from '../../db/schema.js';
import { and, eq, gte, asc, desc, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { logger } from '../../lib/logger.js';
import type { OpportunityTier } from './trend-detection/statistical-trend-engine.js';
import scoringWeights from '../../config/scoring-weights.json' with { type: 'json' };

// ---------------------------------------------------------------------------
// Config — loaded from scoring-weights.json at module initialisation.
//
// tradeShowCategoryKeywords:
//   Keyword lists for fuzzy-matching trade show / distributor category arrays
//   (which use free-text labels) against NCL category names.
//
// categoryAliases:
//   Maps known free-text category labels (as stored by crawlers in
//   retailer_activities.category) to their canonical NCL snake_case name.
//   Matching is case-insensitive. Used to bridge the label gap between
//   crawler output and the NCL category taxonomy.
// ---------------------------------------------------------------------------

const TRADE_SHOW_KEYWORDS: Record<string, string[]> =
  (scoringWeights as any).tradeShowCategoryKeywords ?? {};

const CATEGORY_ALIASES: Record<string, string[]> =
  (scoringWeights as any).categoryAliases ?? {};

/**
 * Maps a raw category label (from crawlers / external data) to its canonical
 * NCL category name.  Returns null if no mapping is found, meaning the
 * activity cannot be attributed to a known NCL opportunity category.
 *
 * Strategy: exact NCL name match first (fastest path for well-formed data),
 * then case-insensitive alias scan.  Aliases cover the display-label variants
 * ("Food & Beverage", "Health & Wellness") that crawlers commonly store.
 */
function normalizeCategoryLabel(raw: string): string | null {
  const lower = raw.toLowerCase().trim();
  // Exact NCL name — already in canonical form
  if (lower in CATEGORY_ALIASES) return lower;
  // Alias scan
  for (const [ncl, aliases] of Object.entries(CATEGORY_ALIASES)) {
    if (aliases.some(a => a.toLowerCase() === lower)) return ncl;
  }
  return null;
}

// Urgency thresholds (days until trade show)
const HIGH_URGENCY_DAYS  = 60;
const MED_URGENCY_DAYS   = 180;

// Distributor density thresholds
const SPARSE_DIST_COUNT   = 2;
const MODERATE_DIST_COUNT = 5;

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface RetailerLeadLag {
  /** true when retailer listing surges precede trade flow spikes */
  leadsTradeFlow: boolean;
  /** months between retailer peak and trade flow peak; positive = retailer leads */
  lagMonths: number | null;
  retailerActivityCount: number;
  retailerSpikePeriod: string | null;   // "YYYY-MM"
  tradeFlowSpikePeriod: string | null;  // "YYYY-MM"
  /** high = ≥2-month separation; medium = 1 month; low = same month or ambiguous */
  confidence: 'high' | 'medium' | 'low';
  evidence: Array<{
    date: string;
    activityType: 'new_listing' | 'category_expansion' | 'seasonal_rotation';
    retailerName: string;
  }>;
}

export interface TradeShowTarget {
  tradeShowId: string;
  name: string;
  location: string | null;
  countryCode: string | null;
  startDate: Date;
  daysUntilShow: number;
  categoryOverlap: string[];
  accelerationScore: number | null;
  yoyGrowthPct: number | null;
  /** high = <60 days; medium = 60–180 days; low = >180 days */
  interventionUrgency: 'high' | 'medium' | 'low';
  exhibitorCount: number | null;
}

export interface DistributorCoverageGap {
  distributorCount: number;
  tradeFlowGrowthPct: number | null;
  accelerationScore: number | null;
  /** sparse = <2; moderate = 2–5; dense = >5 */
  coverageDensity: 'sparse' | 'moderate' | 'dense';
  /** 0–1 composite: high trade growth × low distributor coverage */
  brokeredOpportunityScore: number;
  evidence: Array<{
    distributorName: string;
    categories: string[];
    importsUsGoods: boolean;
  }>;
}

export interface CorrelationBundle {
  id: string;
  category: string;
  countryCode: string;
  opportunityTier: OpportunityTier | null;
  computedAt: Date;
  retailerLeadLag: RetailerLeadLag | null;
  tradeShowTargets: TradeShowTarget[];
  distributorCoverageGap: DistributorCoverageGap | null;
  /** Human-readable compound intelligence statements for downstream narrative agents */
  compoundSignals: string[];
  /** 0–100 composite score: tier base + lead-lag bonus + show urgency + distributor gap */
  compositeCorrelationScore: number;
}

export interface CorrelationRunResult {
  bundlesProduced: number;
  highUrgencyTargets: number;
  retailerLeadsDetected: number;
  sparseCorridorsFound: number;
  topBundles: CorrelationBundle[];
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export class CrossSignalCorrelationAgent {

  async run(
    options: { countryCode?: string; category?: string } = {}
  ): Promise<CorrelationRunResult> {
    logger.info({ options }, '[CrossSignalCorrelation] Starting run');

    const candidates = await this.getCandidatePairs(options);
    logger.info({ count: candidates.length }, '[CrossSignalCorrelation] Candidate pairs');

    // Pre-fetch all upcoming trade shows once (avoids N queries per pair)
    const allUpcomingShows = await db
      .select()
      .from(tradeShows)
      .where(gte(tradeShows.startDate, new Date()))
      .orderBy(asc(tradeShows.startDate))
      .limit(200);

    const bundles: CorrelationBundle[] = [];

    for (const { category, countryCode, opportunityTier } of candidates) {
      try {
        const analytics = await this.getTradeFlowAnalytics(category, countryCode);

        const [leadLag, tradeShowTargets, distributorGap] = await Promise.all([
          this.analyzeRetailerLeadLag(category, countryCode),
          this.findTradeShowTargets(category, countryCode, analytics, allUpcomingShows),
          this.analyzeDistributorCoverageGap(category, countryCode, analytics),
        ]);

        const compoundSignals = this.compoundSignals(
          leadLag, tradeShowTargets, distributorGap, category, countryCode
        );
        const compositeCorrelationScore = this.compositeScore(
          leadLag, tradeShowTargets, distributorGap, opportunityTier
        );

        const bundle: CorrelationBundle = {
          id: randomUUID(),
          category,
          countryCode,
          opportunityTier,
          computedAt: new Date(),
          retailerLeadLag: leadLag,
          tradeShowTargets,
          distributorCoverageGap: distributorGap,
          compoundSignals,
          compositeCorrelationScore,
        };

        bundles.push(bundle);
        await this.persistBundle(bundle);
      } catch (err) {
        logger.error({ err, category, countryCode }, '[CrossSignalCorrelation] Pair failed — skipping');
      }
    }

    bundles.sort((a, b) => b.compositeCorrelationScore - a.compositeCorrelationScore);

    const result: CorrelationRunResult = {
      bundlesProduced: bundles.length,
      highUrgencyTargets: bundles.filter(
        b => b.tradeShowTargets.some(t => t.interventionUrgency === 'high')
      ).length,
      retailerLeadsDetected: bundles.filter(b => b.retailerLeadLag?.leadsTradeFlow === true).length,
      sparseCorridorsFound: bundles.filter(
        b => b.distributorCoverageGap?.coverageDensity === 'sparse'
      ).length,
      topBundles: bundles.slice(0, 10),
    };

    await db.insert(agentOutputs).values({
      id: randomUUID(),
      agentType: 'cross_signal_correlation',
      outputData: result as unknown as Record<string, unknown>,
      relatedEntityIds: [],
      createdAt: new Date(),
    });

    logger.info(result, '[CrossSignalCorrelation] Run complete');
    return result;
  }

  // ── 1. Candidate pairs ─────────────────────────────────────────────────────

  private async getCandidatePairs(
    options: { countryCode?: string; category?: string }
  ): Promise<Array<{ category: string; countryCode: string; opportunityTier: OpportunityTier | null }>> {
    const conditions = [eq(tradeFlowAnalytics.flowType, 'us_to_eu')];
    if (options.countryCode) conditions.push(eq(tradeFlowAnalytics.reporterCountry, options.countryCode));
    if (options.category)    conditions.push(eq(tradeFlowAnalytics.nclCategory, options.category));

    // Distinct (nclCategory, reporterCountry) pairs that have analytics data
    const rows = await db
      .selectDistinct({
        category:     tradeFlowAnalytics.nclCategory,
        countryCode:  tradeFlowAnalytics.reporterCountry,
      })
      .from(tradeFlowAnalytics)
      .where(and(...conditions))
      .limit(60);

    // Enrich with the opportunity tier from the most recent trend for each pair.
    // Reads from the dedicated opportunityTier column (not metadata JSONB).
    const result: Array<{
      category: string;
      countryCode: string;
      opportunityTier: OpportunityTier | null;
    }> = [];

    for (const { category, countryCode } of rows) {
      const latestTrend = await db
        .select({ opportunityTier: trends.opportunityTier })
        .from(trends)
        .where(and(eq(trends.category, category), eq(trends.countryCode, countryCode)))
        .orderBy(desc(trends.createdAt))
        .limit(1);

      result.push({
        category,
        countryCode,
        opportunityTier: (latestTrend[0]?.opportunityTier as OpportunityTier | null) ?? null,
      });
    }

    return result;
  }

  // ── 2. Trade flow analytics for a specific pair ────────────────────────────

  private async getTradeFlowAnalytics(category: string, countryCode: string) {
    const rows = await db
      .select({
        yoyGrowthPct:    tradeFlowAnalytics.yoyGrowthPct,
        accelerationScore: tradeFlowAnalytics.accelerationScore,
        isAccelerating:  tradeFlowAnalytics.isAccelerating,
        breakpointType:  tradeFlowAnalytics.breakpointType,
        usMarketSharePct: tradeFlowAnalytics.usMarketSharePct,
        saturationRiskScore: tradeFlowAnalytics.saturationRiskScore,
      })
      .from(tradeFlowAnalytics)
      .where(and(
        eq(tradeFlowAnalytics.flowType, 'us_to_eu'),
        eq(tradeFlowAnalytics.nclCategory, category),
        eq(tradeFlowAnalytics.reporterCountry, countryCode),
      ))
      .orderBy(desc(tradeFlowAnalytics.asOfYear))
      .limit(1);

    return rows[0] ?? null;
  }

  // ── 3. Retailer lead-lag analysis ──────────────────────────────────────────

  private async analyzeRetailerLeadLag(
    category: string,
    countryCode: string,
  ): Promise<RetailerLeadLag | null> {
    // Query all activities for the country without a category filter so we can
    // normalize free-text labels in JS.  This bridges the label gap between
    // crawler output ("Food & Beverage") and the NCL taxonomy ("food_beverage").
    const allActivities = await db
      .select({
        detectedAt:   retailerActivities.detectedAt,
        activityType: retailerActivities.activityType,
        retailerName: retailerActivities.retailerName,
        category:     retailerActivities.category,
      })
      .from(retailerActivities)
      .where(eq(retailerActivities.countryCode, countryCode))
      .orderBy(asc(retailerActivities.detectedAt));

    // Keep only activities that map to this NCL category (exact name or alias)
    const activities = allActivities.filter(a => {
      if (!a.category) return false;
      const normalized = normalizeCategoryLabel(a.category);
      return normalized === category;
    });

    if (activities.length < 3) return null;

    // Build monthly activity counts keyed "YYYY-MM"
    const retailerMonthly = new Map<string, number>();
    for (const act of activities) {
      const key = act.detectedAt.toISOString().slice(0, 7);
      retailerMonthly.set(key, (retailerMonthly.get(key) ?? 0) + 1);
    }

    // Query monthly trade flow aggregated by YYYYMM
    const tradeRows = await db
      .select({
        yearMonth: tradeFlowMonthly.yearMonth,
        totalUsd:  sql<number>`sum(${tradeFlowMonthly.tradeValueUsd})`.as('total_usd'),
      })
      .from(tradeFlowMonthly)
      .where(and(
        eq(tradeFlowMonthly.flowType, 'us_to_eu'),
        eq(tradeFlowMonthly.nclCategory, category),
        eq(tradeFlowMonthly.reporterCountry, countryCode),
      ))
      .groupBy(tradeFlowMonthly.yearMonth)
      .orderBy(asc(tradeFlowMonthly.yearMonth));

    if (tradeRows.length < 3) return null;

    // Convert YYYYMM integers → "YYYY-MM" string keys
    const tradeMonthly = new Map<string, number>();
    for (const row of tradeRows) {
      const ym = row.yearMonth.toString();
      const key = `${ym.slice(0, 4)}-${ym.slice(4, 6)}`;
      tradeMonthly.set(key, row.totalUsd ?? 0);
    }

    const retailerPeak = this.findPeakMonth(retailerMonthly);
    const tradePeak    = this.findPeakMonth(tradeMonthly);

    if (!retailerPeak || !tradePeak) return null;

    // Positive lagMonths → trade peak is later → retailer led
    const lagMonths = this.monthDiff(retailerPeak, tradePeak);
    const leadsTradeFlow = lagMonths > 0;
    const confidence: 'high' | 'medium' | 'low' =
      Math.abs(lagMonths) >= 2 ? 'high' :
      Math.abs(lagMonths) === 1 ? 'medium' : 'low';

    return {
      leadsTradeFlow,
      lagMonths,
      retailerActivityCount: activities.length,
      retailerSpikePeriod:  retailerPeak,
      tradeFlowSpikePeriod: tradePeak,
      confidence,
      evidence: activities.slice(0, 10).map(a => ({
        date:         a.detectedAt.toISOString().slice(0, 10),
        activityType: a.activityType,
        retailerName: a.retailerName,
      })),
    };
  }

  // ── 4. Trade show targeting ────────────────────────────────────────────────

  private async findTradeShowTargets(
    category: string,
    _countryCode: string,
    analytics: { accelerationScore: number | null; yoyGrowthPct: number | null } | null,
    allUpcomingShows: Array<typeof tradeShows.$inferSelect>,
  ): Promise<TradeShowTarget[]> {
    const keywords = TRADE_SHOW_KEYWORDS[category] ?? [category.replace(/_/g, ' ')];
    const now = new Date();

    const matchingShows = allUpcomingShows.filter(show =>
      (show.categories ?? []).some(cat =>
        keywords.some(kw => cat.toLowerCase().includes(kw.toLowerCase()))
      )
    );

    return matchingShows.map(show => {
      const daysUntilShow = Math.max(
        0,
        Math.round((show.startDate!.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
      );
      const categoryOverlap = (show.categories ?? []).filter(cat =>
        keywords.some(kw => cat.toLowerCase().includes(kw.toLowerCase()))
      );
      const interventionUrgency: 'high' | 'medium' | 'low' =
        daysUntilShow <= HIGH_URGENCY_DAYS ? 'high' :
        daysUntilShow <= MED_URGENCY_DAYS  ? 'medium' : 'low';

      return {
        tradeShowId:       show.id,
        name:              show.name,
        location:          show.location,
        countryCode:       show.countryCode,
        startDate:         show.startDate!,
        daysUntilShow,
        categoryOverlap,
        accelerationScore: analytics?.accelerationScore ?? null,
        yoyGrowthPct:      analytics?.yoyGrowthPct ?? null,
        interventionUrgency,
        exhibitorCount:    show.exhibitorCount,
      };
    });
  }

  // ── 5. Distributor coverage gap ────────────────────────────────────────────

  private async analyzeDistributorCoverageGap(
    category: string,
    countryCode: string,
    analytics: { yoyGrowthPct: number | null; accelerationScore: number | null } | null,
  ): Promise<DistributorCoverageGap | null> {
    const keywords = TRADE_SHOW_KEYWORDS[category] ?? [category.replace(/_/g, ' ')];

    // Fetch all distributors in the country and filter by category in JS.
    // Uses the same trade-show keyword list since distributor category labels
    // are similarly free-text and benefit from substring matching.
    const countryDist = await db
      .select()
      .from(distributors)
      .where(eq(distributors.countryCode, countryCode));

    const relevant = countryDist.filter(d =>
      (d.categories ?? []).some(cat =>
        keywords.some(kw => cat.toLowerCase().includes(kw.toLowerCase()))
      )
    );

    // Return null only when there is genuinely no analytics data AND no distributors
    if (relevant.length === 0 && !analytics) return null;

    const distributorCount = relevant.length;
    const coverageDensity: 'sparse' | 'moderate' | 'dense' =
      distributorCount < SPARSE_DIST_COUNT   ? 'sparse'   :
      distributorCount < MODERATE_DIST_COUNT ? 'moderate' : 'dense';

    const growthRate = Math.max(analytics?.yoyGrowthPct ?? 0, 0);

    // brokeredOpportunityScore: high growth + sparse coverage = maximum score.
    // growthFactor   — normalize: 0% = 0.0, 50%+ = 1.0
    // coverageFactor — normalize: 0 distributors = 1.0, 10+ = 0.0
    const growthFactor   = Math.min(growthRate / 0.5, 1);
    const coverageFactor = distributorCount === 0 ? 1 : Math.max(0, 1 - (distributorCount / 10));
    const brokeredOpportunityScore = Math.round(
      (growthFactor * 0.6 + coverageFactor * 0.4) * 100
    ) / 100;

    return {
      distributorCount,
      tradeFlowGrowthPct:  analytics?.yoyGrowthPct ?? null,
      accelerationScore:   analytics?.accelerationScore ?? null,
      coverageDensity,
      brokeredOpportunityScore,
      evidence: relevant.map(d => ({
        distributorName: d.name,
        categories:      d.categories ?? [],
        importsUsGoods:  d.importsUsGoods ?? false,
      })),
    };
  }

  // ── 6. Compound signals (human-readable narratives) ────────────────────────

  private compoundSignals(
    leadLag: RetailerLeadLag | null,
    tradeShowTargets: TradeShowTarget[],
    distributorGap: DistributorCoverageGap | null,
    category: string,
    countryCode: string,
  ): string[] {
    const signals: string[] = [];

    // Lead-lag signal
    if (leadLag && leadLag.confidence !== 'low') {
      if (leadLag.leadsTradeFlow) {
        signals.push(
          `Retailer new-listing surge in ${countryCode} precedes trade flow spike by ` +
          `${leadLag.lagMonths} month(s) — early-entry window confirmed ` +
          `(confidence: ${leadLag.confidence})`
        );
      } else {
        signals.push(
          `Trade flow growth is driving retailer adoption in ${countryCode} ` +
          `(retail lags trade by ${Math.abs(leadLag.lagMonths ?? 0)} month(s)) — ` +
          `market pull established, entry window open`
        );
      }
    }

    // Trade show urgency
    const highShows = tradeShowTargets.filter(t => t.interventionUrgency === 'high');
    const medShows  = tradeShowTargets.filter(t => t.interventionUrgency === 'medium');
    if (highShows.length > 0) {
      signals.push(
        `${highShows.length} trade show(s) within 60 days cover ${category}: ` +
        highShows.map(s => `${s.name} (${s.daysUntilShow}d, ${s.location ?? s.countryCode})`).join('; ')
      );
    } else if (medShows.length > 0) {
      signals.push(
        `${medShows.length} upcoming trade show(s) in 60–180 days cover ${category}: ` +
        medShows.slice(0, 3).map(s => `${s.name} (${s.daysUntilShow}d)`).join('; ')
      );
    }

    // Distributor gap
    if (distributorGap) {
      if (distributorGap.coverageDensity === 'sparse') {
        signals.push(
          `Only ${distributorGap.distributorCount} distributor(s) cover ${category} in ${countryCode} — ` +
          `NCL broker relationships would fill a critical distribution gap ` +
          `(brokered opportunity: ${Math.round(distributorGap.brokeredOpportunityScore * 100)})`
        );
      } else if (distributorGap.coverageDensity === 'moderate') {
        signals.push(
          `${distributorGap.distributorCount} distributors serving ${category} in ${countryCode} — ` +
          `moderate coverage; selective NCL broker expansion viable`
        );
      }
    }

    // Compound: retailer leads AND distributor is sparse = maximum NCL leverage
    if (leadLag?.leadsTradeFlow && distributorGap?.coverageDensity === 'sparse') {
      signals.push(
        `COMPOUND SIGNAL: Retailer demand is predictive (${leadLag.lagMonths}m lead) AND ` +
        `distribution infrastructure is sparse — NCL can position as first-mover ` +
        `connector before this corridor saturates`
      );
    }

    // Compound: accelerating trade + imminent trade show = highest-priority intercept
    const hasAcceleration = tradeShowTargets.some(t => (t.accelerationScore ?? 0) > 0.3);
    if (hasAcceleration && highShows.length > 0) {
      signals.push(
        `COMPOUND SIGNAL: Accelerating trade flow AND high-urgency trade shows in ` +
        `${category}/${countryCode} — brands attending are likely in active expansion mode`
      );
    }

    return signals;
  }

  // ── 7. Composite correlation score (0–100) ─────────────────────────────────

  private compositeScore(
    leadLag: RetailerLeadLag | null,
    tradeShowTargets: TradeShowTarget[],
    distributorGap: DistributorCoverageGap | null,
    opportunityTier: OpportunityTier | null,
  ): number {
    // Base from opportunity tier (0–40)
    const tierBase: Record<string, number> = {
      breakthrough: 40, accelerating: 32, sustained: 24,
      mature: 16, disrupted: 28, watch: 8,
    };
    let score = tierBase[opportunityTier ?? 'watch'] ?? 8;

    // Lead-lag bonus (0–25): strongest when retailer leads with high confidence
    if (leadLag?.leadsTradeFlow) {
      score += leadLag.confidence === 'high' ? 25 :
               leadLag.confidence === 'medium' ? 15 : 8;
    } else if (leadLag && !leadLag.leadsTradeFlow && leadLag.confidence !== 'low') {
      // Confirmed market pull is still meaningful
      score += 5;
    }

    // Trade show urgency (0–20)
    const highCount = tradeShowTargets.filter(t => t.interventionUrgency === 'high').length;
    const medCount  = tradeShowTargets.filter(t => t.interventionUrgency === 'medium').length;
    score += Math.min(highCount * 10 + medCount * 4, 20);

    // Distributor gap bonus (0–15): brokeredOpportunityScore is 0–1
    if (distributorGap) {
      score += Math.round(distributorGap.brokeredOpportunityScore * 15);
    }

    return Math.min(Math.round(score), 100);
  }

  // ── 8. Persistence ─────────────────────────────────────────────────────────

  private async persistBundle(bundle: CorrelationBundle): Promise<void> {
    await db
      .insert(opportunityCorrelations)
      .values({
        id:                        bundle.id,
        category:                  bundle.category,
        countryCode:               bundle.countryCode,
        opportunityTier:           bundle.opportunityTier,
        compositeCorrelationScore: bundle.compositeCorrelationScore,
        retailerLeadLag:           bundle.retailerLeadLag as unknown as Record<string, unknown>,
        tradeShowTargets:          bundle.tradeShowTargets as unknown as Record<string, unknown>[],
        distributorCoverageGap:    bundle.distributorCoverageGap as unknown as Record<string, unknown>,
        compoundSignals:           bundle.compoundSignals,
        computedAt:                bundle.computedAt,
      })
      .onConflictDoUpdate({
        target: [opportunityCorrelations.category, opportunityCorrelations.countryCode],
        set: {
          opportunityTier:           bundle.opportunityTier,
          compositeCorrelationScore: bundle.compositeCorrelationScore,
          retailerLeadLag:           bundle.retailerLeadLag as unknown as Record<string, unknown>,
          tradeShowTargets:          bundle.tradeShowTargets as unknown as Record<string, unknown>[],
          distributorCoverageGap:    bundle.distributorCoverageGap as unknown as Record<string, unknown>,
          compoundSignals:           bundle.compoundSignals,
          computedAt:                bundle.computedAt,
        },
      });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Returns the "YYYY-MM" key with the highest value in a monthly map. */
  private findPeakMonth(series: Map<string, number>): string | null {
    if (series.size === 0) return null;
    let peakKey   = '';
    let peakValue = -Infinity;
    for (const [key, value] of series.entries()) {
      if (value > peakValue) { peakValue = value; peakKey = key; }
    }
    return peakKey || null;
  }

  /**
   * Returns the signed month difference: (toKey − fromKey) in whole months.
   * Keys are "YYYY-MM" strings. Positive = toKey is later.
   */
  private monthDiff(fromKey: string, toKey: string): number {
    const [fy, fm] = fromKey.split('-').map(Number);
    const [ty, tm] = toKey.split('-').map(Number);
    return (ty - fy) * 12 + (tm - fm);
  }
}
