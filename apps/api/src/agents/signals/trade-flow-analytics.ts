// src/agents/signals/trade-flow-analytics.ts
//
// TradeFlowAnalyticsEngine
//
// Multi-layered trade-flow analytics that detects acceleration, structural
// breakpoints, and competitive market-share shifts for NCL's five EU target
// categories.  Builds on top of the annual tradeFlowIntelligence data already
// collected by TradeFlowIntelligenceAgent and adds three new data layers:
//
//   1. Monthly Comtrade data (Jan 2022 – Dec 2023) for true 6m/12m rolling avg
//   2. Competitor market share per EU country (US / CN / GB / RoW)
//   3. Eurostat household consumption data (best-effort saturation cross-check)
//
// ── Statistical lenses ───────────────────────────────────────────────────────
//   YoY growth      — single-year momentum (current vs previous year)
//   3-yr CAGR       — smoothed mid-term trend (2020→2023)
//   5-yr CAGR       — long-run baseline (2019→2023)
//   Acceleration    — (avg6m / avg12m) − 1; flag when >15% short-term excess
//   OLS regression  — linear slope + R² on 5-point annual series
//   Breakpoint      — 1H(2019-21) vs 2H(2021-23) normalised slope shift >50%
//   Market share    — US / CN / GB / RoW of total EU-country imports per chapter
//   Saturation risk — US share level + US-vs-market growth divergence (0–100)
//
// ── Comtrade endpoints ───────────────────────────────────────────────────────
//   Annual (existing):  .../public/v1/preview/C/A/HS  (already in DB)
//   Monthly (new):      .../public/v1/preview/C/M/HS  period=YYYYMM
//
// ── Run time ─────────────────────────────────────────────────────────────────
//   Fresh run: ~50 API calls (6 monthly + 20 competitor + 5 Eurostat) ≈ 80 s
//   Cached run: DB reads only, <1 s
//

import { db } from '../../db/index.js';
import {
  tradeFlowIntelligence,
  tradeFlowMonthly,
  competitorMarketShare,
  tradeFlowAnalytics,
  agentOutputs,
} from '../../db/schema.js';
import { and, eq, inArray } from 'drizzle-orm';
import { logger } from '../../lib/logger.js';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHAPTER_CATEGORY_MAP: Record<string, string> = {
  '16': 'food_beverage',
  '17': 'food_beverage',
  '18': 'food_beverage',
  '19': 'food_beverage',
  '20': 'food_beverage',
  '21': 'food_beverage',
  '22': 'food_beverage',
  '23': 'food_beverage',
  '24': 'food_beverage',
  '30': 'supplements',
  '33': 'cosmetics_personal_care',
  '94': 'home_goods',
  '95': 'toys_games',
};

const ALL_HS_CHAPTERS = '16,17,18,19,20,21,22,23,24,30,33,94,95';

/** US Comtrade reporter code */
const US_CODE = 842;
/** ISO-2 → Comtrade reporter code for NCL's EU target markets (excl. GB for competitor calls) */
const EU_MARKETS: Record<string, number> = {
  DE: 276,
  FR: 251,
  NL: 528,
  ES: 724,
  IT: 381,
};
/** Full set including GB for monthly us_to_eu flow coverage */
const EU_MARKETS_WITH_GB: Record<string, number> = { ...EU_MARKETS, GB: 826 };

const GB_CODE = 826;
const CN_CODE = 156;
const WORLD_CODE = 0;

/** 5-year window — matches tradeFlowIntelligence */
const ANNUAL_YEARS = [2019, 2020, 2021, 2022, 2023] as const;

/**
 * Monthly periods Jan 2022 – Dec 2023 (24 months).
 * 13 chapters × 24 months = 312 rows/call — within Comtrade's 500-row limit.
 */
const MONTHLY_PERIODS: string[] = (() => {
  const periods: string[] = [];
  for (const year of [2022, 2023]) {
    for (let month = 1; month <= 12; month++) {
      periods.push(`${year}${String(month).padStart(2, '0')}`);
    }
  }
  return periods;
})();
const MONTHLY_PERIOD_PARAM = MONTHLY_PERIODS.join(',');

/** COICOP household expenditure codes → NCL category (for Eurostat nama_10_fcs) */
const COICOP_TO_NCL: Record<string, string> = {
  CP01: 'food_beverage',
  CP05: 'home_goods',
  CP09: 'toys_games',
  CP06: 'supplements',
  CP12: 'cosmetics_personal_care',
};

const COMTRADE_RATE_LIMIT_MS = 1000;
const EUROSTAT_RATE_LIMIT_MS = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ComtradeRow {
  cmdCode: string;
  refYear?: number;
  refMonth?: number;
  period?: number;    // YYYYMM for monthly rows
  flowCode: string;
  reporterCode: number;
  partnerCode: number;
  partner2Code: number;
  customsCode: string;
  motCode: number;
  primaryValue: number;
  netWgt: number;
}

interface ComtradeResponse {
  count: number;
  data?: ComtradeRow[];
}

interface AnnualPoint {
  year: number;
  tradeValueUsd: number | null;
}

interface MonthlyPoint {
  yearMonth: number;   // YYYYMM integer
  tradeValueUsd: number | null;
}

/** Compact competitor share snapshot for a single (euCountry, hsChapter, year) tuple */
interface CompShareSnapshot {
  worldUsd: number | null;
  usUsd: number | null;
  cnUsd: number | null;
  gbUsd: number | null;
}

/** Eurostat household consumption value (EUR millions) */
interface ConsumptionEntry {
  year: number;
  eurMillions: number;
}

export interface TradeFlowAnalyticsResult {
  rowsComputedAndUpserted: number;
  acceleratingCategories: number;
  breakpointsDetected: number;
  /** Number of series where imports are outpacing EU domestic consumption by >10pp */
  oversupplySaturationFlags: number;
  topAcceleration: Array<{
    flowKey: string;
    accelerationScore: number;
    isAccelerating: boolean;
    breakpointType: string | null;
    /** YYYYMM of best monthly breakpoint (if detected) */
    monthlyBreakpointMonth: number | null;
  }>;
  marketShareInsights: Array<{
    euCountry: string;
    nclCategory: string;
    usPct: number | null;
    cnPct: number | null;
    shareTrend: string | null;
  }>;
  /** Series where oversupply saturation flag is active */
  saturationWarnings: Array<{
    flowKey: string;
    importGrowthPct: number | null;
    consumptionGrowthPct: number | null;
    gapPp: number | null;
  }>;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class TradeFlowAnalyticsEngine {
  private readonly log = logger.child({ agent: 'TradeFlowAnalyticsEngine' });

  async run(forceRefresh = false): Promise<TradeFlowAnalyticsResult> {
    this.log.info({ forceRefresh }, '[Analytics] Starting analytics engine run');

    // ── Phase 1: Load annual series from existing tradeFlowIntelligence ────
    const annualSeries = await this.loadAnnualSeries();
    this.log.info(
      { distinctSeries: annualSeries.size },
      '[Analytics] Loaded annual series from DB',
    );

    if (annualSeries.size === 0) {
      this.log.warn('[Analytics] No annual data found — run TradeFlowIntelligenceAgent first');
      return {
        rowsComputedAndUpserted: 0,
        acceleratingCategories: 0,
        breakpointsDetected: 0,
        oversupplySaturationFlags: 0,
        topAcceleration: [],
        marketShareInsights: [],
        saturationWarnings: [],
      };
    }

    // ── Phase 2: Monthly Comtrade data (us_to_eu, Jan 2022 – Dec 2023) ────
    const monthlyMap = await this.fetchOrLoadMonthly(forceRefresh);
    this.log.info({ seriesWithMonthlyData: monthlyMap.size }, '[Analytics] Monthly data ready');

    // ── Phase 3: Competitor market share per EU country ────────────────────
    const compShareMap = await this.fetchOrLoadCompetitorShares(forceRefresh);
    this.log.info(
      { compShareEntries: compShareMap.size },
      '[Analytics] Competitor share data ready',
    );

    // ── Phase 4: Eurostat consumption (best-effort) ────────────────────────
    let consumptionMap: Map<string, ConsumptionEntry[]> = new Map();
    try {
      consumptionMap = await this.fetchEurostatConsumption();
      this.log.info(
        { entries: consumptionMap.size },
        '[Analytics] Eurostat consumption data ready',
      );
    } catch (err) {
      this.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        '[Analytics] Eurostat consumption fetch failed — proceeding without it',
      );
    }

    // ── Phase 5–7: Compute analytics for every series and persist ──────────
    const analyticsRows = this.computeAllAnalytics(
      annualSeries,
      monthlyMap,
      compShareMap,
      consumptionMap,
    );
    this.log.info({ rowsComputed: analyticsRows.length }, '[Analytics] Analytics computed');

    const upserted = await this.persistAnalytics(analyticsRows);

    // ── Phase 8: Log agent output + return summary ─────────────────────────
    const summary = this.buildSummary(analyticsRows);

    await db.insert(agentOutputs).values({
      agentType: 'trade_flow_analytics',
      outputData: {
        runAt: new Date().toISOString(),
        rowsComputed: analyticsRows.length,
        rowsUpserted: upserted,
        ...summary,
      },
      relatedEntityIds: [],
      createdAt: new Date(),
    });

    this.log.info({ rowsUpserted: upserted }, '[Analytics] Run complete');
    return { rowsComputedAndUpserted: upserted, ...summary };
  }

  // ---------------------------------------------------------------------------
  // Phase 1 — Load annual series from tradeFlowIntelligence
  // Returns Map<seriesKey, AnnualPoint[]> sorted ascending by year
  // ---------------------------------------------------------------------------

  private async loadAnnualSeries(): Promise<Map<string, AnnualPoint[]>> {
    const rows = await db
      .select({
        flowType: tradeFlowIntelligence.flowType,
        reporterCountry: tradeFlowIntelligence.reporterCountry,
        partnerCountry: tradeFlowIntelligence.partnerCountry,
        nclCategory: tradeFlowIntelligence.nclCategory,
        hsChapter: tradeFlowIntelligence.hsChapter,
        year: tradeFlowIntelligence.year,
        tradeValueUsd: tradeFlowIntelligence.tradeValueUsd,
      })
      .from(tradeFlowIntelligence)
      .where(inArray(tradeFlowIntelligence.year, [...ANNUAL_YEARS]));

    const map = new Map<string, AnnualPoint[]>();

    for (const row of rows) {
      const key = this.seriesKey(
        row.flowType, row.reporterCountry, row.partnerCountry,
        row.nclCategory, row.hsChapter,
      );
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push({ year: row.year, tradeValueUsd: row.tradeValueUsd ?? null });
    }

    // Sort each series ascending by year
    for (const pts of map.values()) {
      pts.sort((a, b) => a.year - b.year);
    }

    return map;
  }

  // ---------------------------------------------------------------------------
  // Phase 2 — Monthly data: fetch from Comtrade or load from DB
  // Returns Map<seriesKey, MonthlyPoint[]> sorted ascending by yearMonth
  // ---------------------------------------------------------------------------

  private async fetchOrLoadMonthly(
    forceRefresh: boolean,
  ): Promise<Map<string, MonthlyPoint[]>> {
    const map = new Map<string, MonthlyPoint[]>();

    for (const [countryCode, partnerCode] of Object.entries(EU_MARKETS_WITH_GB)) {
      const cacheKey = `us_to_eu|US|${countryCode}`;

      // Check if Dec 2023 data already exists (proxy for fully-cached series)
      if (!forceRefresh) {
        const cached = await db
          .select({ id: tradeFlowMonthly.id })
          .from(tradeFlowMonthly)
          .where(
            and(
              eq(tradeFlowMonthly.flowType, 'us_to_eu'),
              eq(tradeFlowMonthly.reporterCountry, 'US'),
              eq(tradeFlowMonthly.partnerCountry, countryCode),
              eq(tradeFlowMonthly.yearMonth, 202312),
            ),
          )
          .limit(1);

        if (cached.length > 0) {
          this.log.debug({ countryCode }, '[Analytics] Monthly data cached — loading from DB');
          await this.loadMonthlyFromDb('us_to_eu', 'US', countryCode, map);
          continue;
        }
      }

      // Fetch from Comtrade monthly endpoint
      try {
        this.log.info({ countryCode }, '[Analytics] Fetching monthly Comtrade data');
        const rawRows = await this.comtradeMonthlyQuery(US_CODE, partnerCode, 'X');
        const parsed = this.parseMonthlyDataset(rawRows, 'us_to_eu', 'US', countryCode);

        if (parsed.length > 0) {
          await this.persistMonthly(parsed);
          for (const row of parsed) {
            const k = this.seriesKey(
              row.flowType, row.reporterCountry, row.partnerCountry,
              row.nclCategory, row.hsChapter,
            );
            if (!map.has(k)) map.set(k, []);
            map.get(k)!.push({ yearMonth: row.yearMonth, tradeValueUsd: row.tradeValueUsd });
          }
        }

        await this.sleep(COMTRADE_RATE_LIMIT_MS);
      } catch (err) {
        this.log.warn(
          { countryCode, err: err instanceof Error ? err.message : String(err) },
          `[Analytics] Monthly fetch failed for US→${countryCode} — skipping`,
        );
      }
    }

    // Sort all monthly series ascending
    for (const pts of map.values()) {
      pts.sort((a, b) => a.yearMonth - b.yearMonth);
    }

    return map;
  }

  private async loadMonthlyFromDb(
    flowType: string,
    reporterCountry: string,
    partnerCountry: string,
    map: Map<string, MonthlyPoint[]>,
  ): Promise<void> {
    const rows = await db
      .select({
        nclCategory: tradeFlowMonthly.nclCategory,
        hsChapter: tradeFlowMonthly.hsChapter,
        yearMonth: tradeFlowMonthly.yearMonth,
        tradeValueUsd: tradeFlowMonthly.tradeValueUsd,
      })
      .from(tradeFlowMonthly)
      .where(
        and(
          eq(tradeFlowMonthly.flowType, flowType),
          eq(tradeFlowMonthly.reporterCountry, reporterCountry),
          eq(tradeFlowMonthly.partnerCountry, partnerCountry),
        ),
      );

    for (const row of rows) {
      const k = this.seriesKey(flowType, reporterCountry, partnerCountry, row.nclCategory, row.hsChapter);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push({ yearMonth: row.yearMonth, tradeValueUsd: row.tradeValueUsd ?? null });
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 3 — Competitor market share: EU country imports from World/US/CN/GB
  // Returns Map<"${euCountry}|${hsChapter}|${year}", CompShareSnapshot>
  // ---------------------------------------------------------------------------

  private async fetchOrLoadCompetitorShares(
    forceRefresh: boolean,
  ): Promise<Map<string, CompShareSnapshot>> {
    const map = new Map<string, CompShareSnapshot>();
    const COMP_YEARS = '2022,2023';

    for (const [euCountry, reporterCode] of Object.entries(EU_MARKETS)) {
      // Check cache: if 2023 data exists for this country, load from DB
      if (!forceRefresh) {
        const cached = await db
          .select({ id: competitorMarketShare.id })
          .from(competitorMarketShare)
          .where(
            and(
              eq(competitorMarketShare.euCountry, euCountry),
              eq(competitorMarketShare.year, 2023),
            ),
          )
          .limit(1);

        if (cached.length > 0) {
          this.log.debug({ euCountry }, '[Analytics] Competitor shares cached — loading from DB');
          await this.loadCompShareFromDb(euCountry, map);
          continue;
        }
      }

      // Fetch 4 partner calls per EU country
      const partnerEntries: Array<{ code: number; label: 'WORLD' | 'US' | 'CN' | 'GB' }> = [
        { code: WORLD_CODE, label: 'WORLD' },
        { code: US_CODE,    label: 'US' },
        { code: CN_CODE,    label: 'CN' },
        { code: GB_CODE,    label: 'GB' },
      ];

      const rawByPartner = new Map<string, ComtradeRow[]>();

      for (const partner of partnerEntries) {
        try {
          this.log.debug(
            { euCountry, partner: partner.label },
            '[Analytics] Fetching competitor share data',
          );
          const rows = await this.comtradeAnnualQuery(reporterCode, partner.code, COMP_YEARS, 'M');
          rawByPartner.set(partner.label, rows);
          await this.sleep(COMTRADE_RATE_LIMIT_MS);
        } catch (err) {
          this.log.warn(
            { euCountry, partner: partner.label, err: err instanceof Error ? err.message : String(err) },
            '[Analytics] Competitor share fetch failed for partner — skipping',
          );
        }
      }

      // Parse and persist
      const parsed = this.parseAndPersistCompetitorShares(euCountry, rawByPartner);
      this.mergeCompShareIntoMap(parsed, map);
    }

    return map;
  }

  private async loadCompShareFromDb(
    euCountry: string,
    map: Map<string, CompShareSnapshot>,
  ): Promise<void> {
    const rows = await db
      .select({
        hsChapter: competitorMarketShare.hsChapter,
        year: competitorMarketShare.year,
        partnerCountry: competitorMarketShare.partnerCountry,
        importValueUsd: competitorMarketShare.importValueUsd,
      })
      .from(competitorMarketShare)
      .where(eq(competitorMarketShare.euCountry, euCountry));

    for (const row of rows) {
      const k = `${euCountry}|${row.hsChapter}|${row.year}`;
      if (!map.has(k)) {
        map.set(k, { worldUsd: null, usUsd: null, cnUsd: null, gbUsd: null });
      }
      const snap = map.get(k)!;
      const val = row.importValueUsd ?? null;
      if (row.partnerCountry === 'WORLD') snap.worldUsd = val;
      else if (row.partnerCountry === 'US') snap.usUsd = val;
      else if (row.partnerCountry === 'CN') snap.cnUsd = val;
      else if (row.partnerCountry === 'GB') snap.gbUsd = val;
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 4 — Eurostat household consumption (best-effort)
  // Dataset: nama_10_fcs | na_item=P31_S14 | unit=CP_MEUR
  // Returns Map<"${nclCategory}|${euCountry}|${year}", ConsumptionEntry[]>
  // ---------------------------------------------------------------------------

  private async fetchEurostatConsumption(): Promise<Map<string, ConsumptionEntry[]>> {
    const map = new Map<string, ConsumptionEntry[]>();
    const geos = Object.keys(EU_MARKETS).join('&geo=');
    const times = '2022&time=2023';

    for (const [coicop, nclCategory] of Object.entries(COICOP_TO_NCL)) {
      try {
        const url =
          'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/nama_10_fcs' +
          `?format=JSON&lang=en&unit=CP_MEUR&na_item=P31_S14` +
          `&geo=${geos}&coicop=${coicop}&time=${times}`;

        const resp = await fetch(url, {
          headers: {
            Accept: 'application/json',
            'User-Agent': 'NCL-MarketIntelligenceEngine/1.0 (research use)',
          },
          signal: AbortSignal.timeout(20_000),
        });

        if (!resp.ok) {
          this.log.debug(
            { coicop, status: resp.status },
            '[Analytics] Eurostat consumption non-OK — skipping COICOP',
          );
          continue;
        }

        const json = (await resp.json()) as Record<string, unknown>;
        this.parseConsumptionResponse(json, nclCategory, map);
        await this.sleep(EUROSTAT_RATE_LIMIT_MS);
      } catch (err) {
        this.log.debug(
          { coicop, err: err instanceof Error ? err.message : String(err) },
          '[Analytics] Eurostat consumption fetch failed for COICOP — skipping',
        );
      }
    }

    return map;
  }

  // ---------------------------------------------------------------------------
  // Phase 5 — Compute analytics for every annual series
  // ---------------------------------------------------------------------------

  private computeAllAnalytics(
    annualSeries: Map<string, AnnualPoint[]>,
    monthlyMap: Map<string, MonthlyPoint[]>,
    compShareMap: Map<string, CompShareSnapshot>,
    consumptionMap: Map<string, ConsumptionEntry[]>,
  ): AnalyticsRow[] {
    const rows: AnalyticsRow[] = [];

    for (const [key, annualPts] of annualSeries) {
      const [flowType, reporterCountry, partnerCountry, nclCategory, hsChapter] = key.split('|');
      const validPts = annualPts.filter(p => p.tradeValueUsd != null && p.tradeValueUsd > 0);
      if (validPts.length < 2) continue;

      const valueByYear = new Map(annualPts.map(p => [p.year, p.tradeValueUsd]));
      const asOfYear = Math.max(...annualPts.map(p => p.year));
      const currentVal = valueByYear.get(asOfYear) ?? null;
      const prevVal = valueByYear.get(asOfYear - 1) ?? null;

      // ── YoY growth ────────────────────────────────────────────────────────
      const yoyGrowthPct =
        currentVal != null && prevVal != null && prevVal > 0
          ? r((currentVal - prevVal) / prevVal * 100)
          : null;

      // ── CAGR ──────────────────────────────────────────────────────────────
      const v2019 = valueByYear.get(2019) ?? null;
      const v2020 = valueByYear.get(2020) ?? null;
      const v2023 = valueByYear.get(2023) ?? null;

      const cagr5yr =
        v2019 != null && v2019 > 0 && v2023 != null && v2023 > 0
          ? r((Math.pow(v2023 / v2019, 1 / 4) - 1) * 100)
          : null;

      const cagr3yr =
        v2020 != null && v2020 > 0 && v2023 != null && v2023 > 0
          ? r((Math.pow(v2023 / v2020, 1 / 3) - 1) * 100)
          : null;

      // ── OLS linear regression on 5-point annual series ────────────────────
      const xsAll = validPts.map(p => p.year - 2019);
      const ysAll = validPts.map(p => p.tradeValueUsd!);
      const ols = TradeFlowAnalyticsEngine.olsLinear(xsAll, ysAll);
      const linearTrendSlope = ols ? r(ols.slope) : null;
      const rSquared = ols ? r(ols.rSquared) : null;

      // ── Breakpoint detection (sliding scan — best-fit year, not hardcoded) ─
      const bp = this.detectBreakpointScanning(annualPts);

      // ── Rolling averages + monthly OLS + monthly breakpoint ──────────────
      const monthlyPts = (monthlyMap.get(key) ?? []).filter(m => m.tradeValueUsd != null);
      const last12 = monthlyPts.slice(-12);
      const last6 = monthlyPts.slice(-6);

      const avg12mUsd = last12.length >= 6
        ? r(last12.reduce((s, m) => s + m.tradeValueUsd!, 0) / last12.length)
        : null;
      const avg6mUsd = last6.length >= 3
        ? r(last6.reduce((s, m) => s + m.tradeValueUsd!, 0) / last6.length)
        : null;

      // ── Monthly OLS (24-month series) ────────────────────────────────────
      const monthlyOls = this.monthlyOlsAnalysis(monthlyPts);
      const monthlyOlsSlope = monthlyOls.slope;
      const monthlyOlsRSquared = monthlyOls.rSquared;

      // ── Monthly breakpoint scan ───────────────────────────────────────────
      const monthlyBreakpointMonth = this.detectMonthlyBreakpoint(monthlyPts);

      // ── Acceleration score ────────────────────────────────────────────────
      // Primary: (avg6m / avg12m) − 1   (requires monthly data)
      // Fallback: (yoyGrowthPct − cagr5yr) / |cagr5yr|  (annual only)
      let accelerationScore: number | null = null;
      let shortTermMomentum: number | null = null;

      if (avg6mUsd != null && avg12mUsd != null && avg12mUsd > 0) {
        shortTermMomentum = r(avg6mUsd);
        accelerationScore = r((avg6mUsd / avg12mUsd - 1) * 100);
      } else if (yoyGrowthPct != null && cagr5yr != null && Math.abs(cagr5yr) > 0.01) {
        shortTermMomentum = r(yoyGrowthPct);
        accelerationScore = r((yoyGrowthPct - cagr5yr) / Math.abs(cagr5yr) * 100);
      }

      const isAccelerating = accelerationScore != null && accelerationScore > 15;

      // ── Competitor market share (us_to_eu flows only) ────────────────────
      let usMarketSharePct: number | null = null;
      let usMarketSharePriorPct: number | null = null;
      let shareChangePct: number | null = null;
      let shareTrend: string | null = null;
      let chinaMarketSharePct: number | null = null;
      let ukMarketSharePct: number | null = null;
      let rowMarketSharePct: number | null = null;
      let usVsChinaShareDiff: number | null = null;
      let usGrowthVsMarketRatio: number | null = null;
      let saturationRiskScore: number | null = null;

      if (flowType === 'us_to_eu') {
        const snapCurrent = compShareMap.get(`${partnerCountry}|${hsChapter}|2023`);
        const snapPrior = compShareMap.get(`${partnerCountry}|${hsChapter}|2022`);

        if (snapCurrent?.worldUsd != null && snapCurrent.worldUsd > 0) {
          const w = snapCurrent.worldUsd;
          usMarketSharePct = snapCurrent.usUsd != null ? r((snapCurrent.usUsd / w) * 100) : null;
          chinaMarketSharePct = snapCurrent.cnUsd != null ? r((snapCurrent.cnUsd / w) * 100) : null;
          ukMarketSharePct = snapCurrent.gbUsd != null ? r((snapCurrent.gbUsd / w) * 100) : null;

          const knownShares =
            (snapCurrent.usUsd ?? 0) + (snapCurrent.cnUsd ?? 0) + (snapCurrent.gbUsd ?? 0);
          rowMarketSharePct = r(Math.max(0, (w - knownShares) / w) * 100);

          usVsChinaShareDiff =
            usMarketSharePct != null && chinaMarketSharePct != null
              ? r(usMarketSharePct - chinaMarketSharePct)
              : null;
        }

        if (snapPrior?.worldUsd != null && snapPrior.worldUsd > 0 && snapPrior.usUsd != null) {
          usMarketSharePriorPct = r((snapPrior.usUsd / snapPrior.worldUsd) * 100);
        }

        if (usMarketSharePct != null && usMarketSharePriorPct != null) {
          shareChangePct = r(usMarketSharePct - usMarketSharePriorPct);
          if (Math.abs(shareChangePct) < 1) shareTrend = 'stable';
          else shareTrend = shareChangePct > 0 ? 'gaining' : 'losing';
        }

        // Saturation risk: US share level + US growth vs market growth
        const snapC = compShareMap.get(`${partnerCountry}|${hsChapter}|2023`);
        const snapP = compShareMap.get(`${partnerCountry}|${hsChapter}|2022`);
        if (
          snapC?.worldUsd != null && snapC.worldUsd > 0 &&
          snapP?.worldUsd != null && snapP.worldUsd > 0
        ) {
          const worldGrowth = (snapC.worldUsd - snapP.worldUsd) / snapP.worldUsd;
          const usGrowth =
            snapC.usUsd != null && snapP.usUsd != null && snapP.usUsd > 0
              ? (snapC.usUsd - snapP.usUsd) / snapP.usUsd
              : null;
          if (usGrowth != null && Math.abs(worldGrowth) > 0.001) {
            usGrowthVsMarketRatio = r(usGrowth / Math.abs(worldGrowth));
          }
        }

        // Composite saturation score (0–100)
        const shareComponent = usMarketSharePct != null
          ? Math.min(50, (usMarketSharePct / 50) * 50)  // 50%+ share → max 50 pts
          : 0;
        const growthComponent = usGrowthVsMarketRatio != null
          ? Math.min(50, Math.max(0, (usGrowthVsMarketRatio - 1) * 25))  // >1× market growth → up to 50 pts
          : 0;
        saturationRiskScore = r(shareComponent + growthComponent);
      }

      // ── Eurostat consumption cross-reference ──────────────────────────────
      let euConsumptionEurM: number | null = null;
      let importIntensityPct: number | null = null;
      let consumptionGrowthPct: number | null = null;

      const consumKey = `${nclCategory}|${partnerCountry}`;
      const consumEntries = consumptionMap.get(consumKey);
      if (consumEntries && consumEntries.length > 0) {
        const latest = consumEntries.find(e => e.year === 2023) ?? consumEntries[consumEntries.length - 1];
        const prior = consumEntries.find(e => e.year === 2022);

        if (latest) {
          euConsumptionEurM = r(latest.eurMillions);
          // importIntensity = US imports / total consumption × 100
          if (currentVal != null && euConsumptionEurM > 0) {
            // currentVal is USD; convert to EUR approx (÷1.08) then to millions (÷1e6)
            const usImportEurM = currentVal / 1.08 / 1_000_000;
            importIntensityPct = r((usImportEurM / euConsumptionEurM) * 100);
          }
        }

        if (latest && prior && prior.eurMillions > 0) {
          consumptionGrowthPct = r(
            ((latest.eurMillions - prior.eurMillions) / prior.eurMillions) * 100,
          );
        }
      }

      // ── Oversupply saturation signal ──────────────────────────────────────
      const { gap: importVsConsumptionGrowthGap, flag: oversupplySaturationFlag } =
        this.computeOversupplySaturation(yoyGrowthPct, consumptionGrowthPct);

      rows.push({
        flowType,
        reporterCountry,
        partnerCountry,
        nclCategory,
        hsChapter,
        asOfYear,
        yoyGrowthPct,
        cagr3yr,
        cagr5yr,
        avg6mUsd,
        avg12mUsd,
        shortTermMomentum,
        accelerationScore,
        isAccelerating,
        linearTrendSlope,
        rSquared,
        breakpointDetected: bp.detected,
        breakpointYear: bp.breakpointYear,
        breakpointType: bp.type,
        firstHalfSlope: bp.firstHalfSlope,
        secondHalfSlope: bp.secondHalfSlope,
        monthlyOlsSlope,
        monthlyOlsRSquared,
        monthlyBreakpointMonth,
        usMarketSharePct,
        usMarketSharePriorPct,
        shareChangePct,
        shareTrend,
        chinaMarketSharePct,
        ukMarketSharePct,
        rowMarketSharePct,
        usVsChinaShareDiff,
        usGrowthVsMarketRatio,
        saturationRiskScore,
        euConsumptionEurM,
        importIntensityPct,
        consumptionGrowthPct,
        importVsConsumptionGrowthGap,
        oversupplySaturationFlag,
      });
    }

    return rows;
  }

  // ---------------------------------------------------------------------------
  // Monthly OLS analysis — regression on 24-point monthly series
  //
  // Uses the same data already fetched in Phase 2 (monthlyMap).  Runs OLS on
  // monthIndex (0–23) vs tradeValueUsd to produce a slope in USD/month and R².
  // A positive slope with R² > 0.5 indicates a sustained structural uptrend
  // independent of the annual snapshots used by the existing 5-point OLS.
  // ---------------------------------------------------------------------------

  private monthlyOlsAnalysis(monthlyPts: MonthlyPoint[]): {
    slope: number | null;
    rSquared: number | null;
  } {
    const valid = monthlyPts.filter(m => m.tradeValueUsd != null && m.tradeValueUsd > 0);
    if (valid.length < 6) return { slope: null, rSquared: null };

    // Sort ascending and assign integer indices 0…n-1 regardless of gaps
    const sorted = [...valid].sort((a, b) => a.yearMonth - b.yearMonth);
    const xs = sorted.map((_, i) => i);
    const ys = sorted.map(m => m.tradeValueUsd!);

    const result = TradeFlowAnalyticsEngine.olsLinear(xs, ys);
    if (!result) return { slope: null, rSquared: null };

    return { slope: r(result.slope), rSquared: r(result.rSquared) };
  }

  // ---------------------------------------------------------------------------
  // Sliding breakpoint scan — annual series
  //
  // Replaces the hardcoded 2021 split. Tests every valid candidate year as the
  // breakpoint (requires ≥2 points in each half) and returns the year that
  // maximises the absolute normalised slope change (i.e., the most structurally
  // significant inflection point).
  // ---------------------------------------------------------------------------

  private detectBreakpointScanning(annualPts: AnnualPoint[]): {
    detected: boolean;
    breakpointYear: number | null;
    type: string | null;
    firstHalfSlope: number | null;
    secondHalfSlope: number | null;
  } {
    const valid = annualPts.filter(p => p.tradeValueUsd != null && p.tradeValueUsd > 0);
    if (valid.length < 4) {
      // Fewer than 4 points cannot form two halves of ≥2 each — skip
      return { detected: false, breakpointYear: null, type: null, firstHalfSlope: null, secondHalfSlope: null };
    }

    const years = valid.map(p => p.year);
    const minYear = Math.min(...years);
    const maxYear = Math.max(...years);

    let bestNormalisedShift = 0;
    let bestYear: number | null = null;
    let bestOls1: { slope: number; rSquared: number } | null = null;
    let bestOls2: { slope: number; rSquared: number } | null = null;

    // Candidate breakpoint years: every interior year with ≥2 points on each side
    for (let candidateYear = minYear + 1; candidateYear <= maxYear - 1; candidateYear++) {
      const firstHalf = valid.filter(p => p.year <= candidateYear);
      const secondHalf = valid.filter(p => p.year >= candidateYear);
      if (firstHalf.length < 2 || secondHalf.length < 2) continue;

      const ols1 = TradeFlowAnalyticsEngine.olsLinear(
        firstHalf.map(p => p.year - minYear),
        firstHalf.map(p => p.tradeValueUsd!),
      );
      const ols2 = TradeFlowAnalyticsEngine.olsLinear(
        secondHalf.map(p => p.year - minYear),
        secondHalf.map(p => p.tradeValueUsd!),
      );
      if (!ols1 || !ols2) continue;

      const slopeChange = ols2.slope - ols1.slope;
      const normalisedShift = Math.abs(slopeChange) / (Math.abs(ols1.slope) + 1);

      if (normalisedShift > bestNormalisedShift) {
        bestNormalisedShift = normalisedShift;
        bestYear = candidateYear;
        bestOls1 = ols1;
        bestOls2 = ols2;
      }
    }

    // Require normalised shift > 50% to call it a structural breakpoint
    const detected = bestNormalisedShift > 0.5 && bestYear !== null && bestOls1 !== null && bestOls2 !== null;

    let type: string | null = null;
    if (detected && bestOls1 && bestOls2) {
      if ((bestOls1.slope >= 0) !== (bestOls2.slope >= 0)) type = 'reversal';
      else if (bestOls2.slope > bestOls1.slope) type = 'acceleration';
      else type = 'deceleration';
    }

    return {
      detected,
      breakpointYear: detected ? bestYear : null,
      type,
      firstHalfSlope: bestOls1 ? r(bestOls1.slope) : null,
      secondHalfSlope: bestOls2 ? r(bestOls2.slope) : null,
    };
  }

  // ---------------------------------------------------------------------------
  // Monthly breakpoint scan — 24-month series
  //
  // Scans candidate split months within the monthly series (minimum 3 points
  // each side) to find the month index at which the slope shift is largest.
  // Returns the YYYYMM of the best breakpoint, or null if none is significant.
  // ---------------------------------------------------------------------------

  private detectMonthlyBreakpoint(monthlyPts: MonthlyPoint[]): number | null {
    const valid = monthlyPts
      .filter(m => m.tradeValueUsd != null && m.tradeValueUsd > 0)
      .sort((a, b) => a.yearMonth - b.yearMonth);

    if (valid.length < 8) return null; // need at least 3+3 plus margin

    const MIN_EACH_SIDE = 3;
    let bestShift = 0;
    let bestIdx: number | null = null;

    for (let split = MIN_EACH_SIDE; split <= valid.length - MIN_EACH_SIDE; split++) {
      const firstHalf = valid.slice(0, split);
      const secondHalf = valid.slice(split);

      const ols1 = TradeFlowAnalyticsEngine.olsLinear(
        firstHalf.map((_, i) => i),
        firstHalf.map(m => m.tradeValueUsd!),
      );
      const ols2 = TradeFlowAnalyticsEngine.olsLinear(
        secondHalf.map((_, i) => i),
        secondHalf.map(m => m.tradeValueUsd!),
      );
      if (!ols1 || !ols2) continue;

      const shift = Math.abs(ols2.slope - ols1.slope) / (Math.abs(ols1.slope) + 1);
      if (shift > bestShift) {
        bestShift = shift;
        bestIdx = split;
      }
    }

    // Only surface as a meaningful breakpoint if shift is substantial (>50%)
    if (bestShift <= 0.5 || bestIdx === null) return null;
    return valid[bestIdx]!.yearMonth;
  }

  // ---------------------------------------------------------------------------
  // Oversupply saturation signal
  //
  // Compares the import YoY growth rate against EU domestic consumption growth.
  // When imports grow materially faster than domestic demand (+10pp gap), it
  // signals that supply build-up may be outpacing organic market expansion —
  // a leading indicator of price pressure or distributor destocking for NCL clients.
  //
  // Thresholds are conservative: a 10pp gap is a meaningful divergence at the
  // category level but not so tight as to flag normal year-to-year noise.
  // ---------------------------------------------------------------------------

  private computeOversupplySaturation(
    yoyGrowthPct: number | null,
    consumptionGrowthPct: number | null,
  ): { gap: number | null; flag: boolean } {
    if (yoyGrowthPct == null || consumptionGrowthPct == null) {
      return { gap: null, flag: false };
    }
    const gap = r(yoyGrowthPct - consumptionGrowthPct);
    return { gap, flag: gap > 10 };
  }

  // ---------------------------------------------------------------------------
  // OLS linear regression (inline — no external lib needed)
  // Returns slope and R² or null if insufficient data.
  // ---------------------------------------------------------------------------

  static olsLinear(
    xs: number[],
    ys: number[],
  ): { slope: number; rSquared: number } | null {
    const n = xs.length;
    if (n < 2 || xs.length !== ys.length) return null;

    const sumX  = xs.reduce((a, b) => a + b, 0);
    const sumY  = ys.reduce((a, b) => a + b, 0);
    const sumXY = xs.reduce((s, x, i) => s + x * ys[i]!, 0);
    const sumXX = xs.reduce((s, x) => s + x * x, 0);

    const denom = n * sumXX - sumX * sumX;
    if (denom === 0) return null;

    const slope     = (n * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / n;
    const yMean     = sumY / n;

    const ssTot = ys.reduce((s, y) => s + (y - yMean) ** 2, 0);
    const ssRes = ys.reduce((s, y, i) => s + (y - (slope * xs[i]! + intercept)) ** 2, 0);
    const rSquared = ssTot === 0 ? 1 : Math.max(0, 1 - ssRes / ssTot);

    return { slope, rSquared };
  }

  // ---------------------------------------------------------------------------
  // Breakpoint detection — 1H(2019-2021) vs 2H(2021-2023) slope shift
  // Normalised shift >50% of |firstHalfSlope| triggers a breakpoint.
  // ---------------------------------------------------------------------------

  private detectBreakpoint(annualPts: AnnualPoint[]): {
    detected: boolean;
    breakpointYear: number | null;
    type: string | null;
    firstHalfSlope: number | null;
    secondHalfSlope: number | null;
  } {
    const valid = annualPts.filter(p => p.tradeValueUsd != null && p.tradeValueUsd > 0);
    const firstHalf = valid.filter(p => p.year <= 2021);
    const secondHalf = valid.filter(p => p.year >= 2021);

    if (firstHalf.length < 2 || secondHalf.length < 2) {
      return { detected: false, breakpointYear: null, type: null, firstHalfSlope: null, secondHalfSlope: null };
    }

    const ols1 = TradeFlowAnalyticsEngine.olsLinear(
      firstHalf.map(p => p.year - 2019),
      firstHalf.map(p => p.tradeValueUsd!),
    );
    const ols2 = TradeFlowAnalyticsEngine.olsLinear(
      secondHalf.map(p => p.year - 2019),
      secondHalf.map(p => p.tradeValueUsd!),
    );

    if (!ols1 || !ols2) {
      return { detected: false, breakpointYear: null, type: null, firstHalfSlope: null, secondHalfSlope: null };
    }

    // Normalise shift by |slope1| + small floor to avoid div-by-zero on flat series
    const slopeChange      = ols2.slope - ols1.slope;
    const normalisedShift  = Math.abs(slopeChange) / (Math.abs(ols1.slope) + 1);
    const detected         = normalisedShift > 0.5;

    let type: string | null = null;
    if (detected) {
      const s1pos = ols1.slope >= 0;
      const s2pos = ols2.slope >= 0;
      if (s1pos !== s2pos) type = 'reversal';
      else if (ols2.slope > ols1.slope) type = 'acceleration';
      else type = 'deceleration';
    }

    return {
      detected,
      breakpointYear: detected ? 2021 : null,
      type,
      firstHalfSlope: r(ols1.slope),
      secondHalfSlope: r(ols2.slope),
    };
  }

  // ---------------------------------------------------------------------------
  // Persist monthly rows (upsert on unique index)
  // ---------------------------------------------------------------------------

  private async persistMonthly(
    rows: Array<{
      flowType: string; reporterCountry: string; partnerCountry: string;
      nclCategory: string; hsChapter: string; yearMonth: number;
      tradeValueUsd: number | null; netWeightKg: number | null;
    }>,
  ): Promise<void> {
    for (const row of rows) {
      try {
        await db
          .insert(tradeFlowMonthly)
          .values({
            id: randomUUID(),
            flowType: row.flowType,
            reporterCountry: row.reporterCountry,
            partnerCountry: row.partnerCountry,
            nclCategory: row.nclCategory,
            hsChapter: row.hsChapter,
            yearMonth: row.yearMonth,
            tradeValueUsd: row.tradeValueUsd,
            netWeightKg: row.netWeightKg,
            source: 'comtrade',
            fetchedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [
              tradeFlowMonthly.flowType,
              tradeFlowMonthly.reporterCountry,
              tradeFlowMonthly.partnerCountry,
              tradeFlowMonthly.nclCategory,
              tradeFlowMonthly.hsChapter,
              tradeFlowMonthly.yearMonth,
            ],
            set: {
              tradeValueUsd: row.tradeValueUsd,
              netWeightKg: row.netWeightKg,
              fetchedAt: new Date(),
            },
          });
      } catch (err) {
        this.log.warn(
          { yearMonth: row.yearMonth, err: err instanceof Error ? err.message : String(err) },
          '[Analytics] Monthly upsert failed',
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Parse competitor share raw data and persist to DB
  // ---------------------------------------------------------------------------

  private parseAndPersistCompetitorShares(
    euCountry: string,
    rawByPartner: Map<string, ComtradeRow[]>,
  ): Array<{
    euCountry: string; hsChapter: string; nclCategory: string;
    year: number; partnerCountry: string;
    importValueUsd: number | null; marketSharePct: number | null;
  }> {
    // Collect (chapter, year, partner) → USD
    const byChapterYear = new Map<
      string,
      { world?: number; us?: number; cn?: number; gb?: number }
    >();

    const labelMap: Record<string, string> = {
      WORLD: 'world', US: 'us', CN: 'cn', GB: 'gb',
    };

    for (const [partnerLabel, rows] of rawByPartner) {
      const field = labelMap[partnerLabel];
      if (!field) continue;

      for (const row of rows) {
        const code = String(row.cmdCode).replace(/\s/g, '');
        const chapter = code.startsWith('2106') ? '2106' : code.substring(0, 2);
        if (!CHAPTER_CATEGORY_MAP[chapter]) continue;

        const year = row.refYear ?? 0;
        if (year === 0) continue;

        const k = `${chapter}|${year}`;
        if (!byChapterYear.has(k)) byChapterYear.set(k, {});
        const entry = byChapterYear.get(k)!;
        const val = row.primaryValue > 0 ? row.primaryValue : 0;
        (entry as Record<string, number>)[field] = val;
      }
    }

    const toInsert: ReturnType<typeof this.parseAndPersistCompetitorShares> = [];

    for (const [chapterYear, vals] of byChapterYear) {
      const [chapter, yearStr] = chapterYear.split('|');
      const year = parseInt(yearStr!, 10);
      const nclCategory = chapter === '2106' ? 'supplements' : (CHAPTER_CATEGORY_MAP[chapter!] ?? '');
      if (!nclCategory) continue;

      const world = vals.world ?? null;

      for (const [partnerLabel, val] of [
        ['WORLD', world],
        ['US', vals.us ?? null],
        ['CN', vals.cn ?? null],
        ['GB', vals.gb ?? null],
      ] as Array<[string, number | null]>) {
        const marketSharePct =
          partnerLabel !== 'WORLD' && val != null && world != null && world > 0
            ? r((val / world) * 100)
            : null;

        toInsert.push({
          euCountry, hsChapter: chapter!, nclCategory, year,
          partnerCountry: partnerLabel,
          importValueUsd: val,
          marketSharePct,
        });
      }
    }

    // Persist
    void this.persistCompetitorShares(toInsert);

    return toInsert;
  }

  private async persistCompetitorShares(
    rows: Array<{
      euCountry: string; hsChapter: string; nclCategory: string;
      year: number; partnerCountry: string;
      importValueUsd: number | null; marketSharePct: number | null;
    }>,
  ): Promise<void> {
    for (const row of rows) {
      try {
        await db
          .insert(competitorMarketShare)
          .values({ id: randomUUID(), ...row, fetchedAt: new Date() })
          .onConflictDoUpdate({
            target: [
              competitorMarketShare.euCountry,
              competitorMarketShare.hsChapter,
              competitorMarketShare.year,
              competitorMarketShare.partnerCountry,
            ],
            set: {
              importValueUsd: row.importValueUsd,
              marketSharePct: row.marketSharePct,
              fetchedAt: new Date(),
            },
          });
      } catch (err) {
        this.log.warn(
          { euCountry: row.euCountry, partner: row.partnerCountry, err: err instanceof Error ? err.message : String(err) },
          '[Analytics] Competitor share upsert failed',
        );
      }
    }
  }

  private mergeCompShareIntoMap(
    rows: Array<{
      euCountry: string; hsChapter: string; year: number;
      partnerCountry: string; importValueUsd: number | null;
    }>,
    map: Map<string, CompShareSnapshot>,
  ): void {
    for (const row of rows) {
      const k = `${row.euCountry}|${row.hsChapter}|${row.year}`;
      if (!map.has(k)) map.set(k, { worldUsd: null, usUsd: null, cnUsd: null, gbUsd: null });
      const snap = map.get(k)!;
      const val = row.importValueUsd;
      if (row.partnerCountry === 'WORLD') snap.worldUsd = val;
      else if (row.partnerCountry === 'US') snap.usUsd = val;
      else if (row.partnerCountry === 'CN') snap.cnUsd = val;
      else if (row.partnerCountry === 'GB') snap.gbUsd = val;
    }
  }

  // ---------------------------------------------------------------------------
  // Persist analytics rows (upsert on unique index)
  // ---------------------------------------------------------------------------

  private async persistAnalytics(rows: AnalyticsRow[]): Promise<number> {
    let upserted = 0;

    for (const row of rows) {
      try {
        await db
          .insert(tradeFlowAnalytics)
          .values({ id: randomUUID(), ...row, computedAt: new Date() })
          .onConflictDoUpdate({
            target: [
              tradeFlowAnalytics.flowType,
              tradeFlowAnalytics.reporterCountry,
              tradeFlowAnalytics.partnerCountry,
              tradeFlowAnalytics.nclCategory,
              tradeFlowAnalytics.hsChapter,
              tradeFlowAnalytics.asOfYear,
            ],
            set: {
              yoyGrowthPct:           row.yoyGrowthPct,
              cagr3yr:                row.cagr3yr,
              cagr5yr:                row.cagr5yr,
              avg6mUsd:               row.avg6mUsd,
              avg12mUsd:              row.avg12mUsd,
              shortTermMomentum:      row.shortTermMomentum,
              accelerationScore:      row.accelerationScore,
              isAccelerating:         row.isAccelerating,
              linearTrendSlope:       row.linearTrendSlope,
              rSquared:               row.rSquared,
              breakpointDetected:     row.breakpointDetected,
              breakpointYear:         row.breakpointYear,
              breakpointType:         row.breakpointType,
              firstHalfSlope:         row.firstHalfSlope,
              secondHalfSlope:        row.secondHalfSlope,
              usMarketSharePct:       row.usMarketSharePct,
              usMarketSharePriorPct:  row.usMarketSharePriorPct,
              shareChangePct:         row.shareChangePct,
              shareTrend:             row.shareTrend,
              chinaMarketSharePct:    row.chinaMarketSharePct,
              ukMarketSharePct:       row.ukMarketSharePct,
              rowMarketSharePct:      row.rowMarketSharePct,
              usVsChinaShareDiff:     row.usVsChinaShareDiff,
              usGrowthVsMarketRatio:  row.usGrowthVsMarketRatio,
              saturationRiskScore:    row.saturationRiskScore,
              euConsumptionEurM:              row.euConsumptionEurM,
              importIntensityPct:             row.importIntensityPct,
              consumptionGrowthPct:           row.consumptionGrowthPct,
              monthlyOlsSlope:                row.monthlyOlsSlope,
              monthlyOlsRSquared:             row.monthlyOlsRSquared,
              monthlyBreakpointMonth:         row.monthlyBreakpointMonth,
              importVsConsumptionGrowthGap:   row.importVsConsumptionGrowthGap,
              oversupplySaturationFlag:       row.oversupplySaturationFlag,
              computedAt:                     new Date(),
            },
          });
        upserted++;
      } catch (err) {
        this.log.warn(
          {
            key: this.seriesKey(
              row.flowType, row.reporterCountry, row.partnerCountry,
              row.nclCategory, row.hsChapter,
            ),
            err: err instanceof Error ? err.message : String(err),
          },
          '[Analytics] Analytics upsert failed',
        );
      }
    }

    return upserted;
  }

  // ---------------------------------------------------------------------------
  // Build intelligence summary
  // ---------------------------------------------------------------------------

  private buildSummary(
    rows: AnalyticsRow[],
  ): Omit<TradeFlowAnalyticsResult, 'rowsComputedAndUpserted'> {
    const acceleratingCategories = rows.filter(r => r.isAccelerating).length;
    const breakpointsDetected = rows.filter(r => r.breakpointDetected).length;
    const oversupplySaturationFlags = rows.filter(r => r.oversupplySaturationFlag).length;

    const topAcceleration = [...rows]
      .filter(r => r.accelerationScore != null)
      .sort((a, b) => (b.accelerationScore ?? 0) - (a.accelerationScore ?? 0))
      .slice(0, 10)
      .map(r => ({
        flowKey: this.seriesKey(r.flowType, r.reporterCountry, r.partnerCountry, r.nclCategory, r.hsChapter),
        accelerationScore: r.accelerationScore!,
        isAccelerating: r.isAccelerating,
        breakpointType: r.breakpointType,
        monthlyBreakpointMonth: r.monthlyBreakpointMonth,
      }));

    const marketShareInsights = [...rows]
      .filter(r => r.flowType === 'us_to_eu' && r.usMarketSharePct != null)
      .sort((a, b) => (b.usMarketSharePct ?? 0) - (a.usMarketSharePct ?? 0))
      .slice(0, 15)
      .map(r => ({
        euCountry: r.partnerCountry,
        nclCategory: r.nclCategory,
        usPct: r.usMarketSharePct,
        cnPct: r.chinaMarketSharePct,
        shareTrend: r.shareTrend,
      }));

    const saturationWarnings = [...rows]
      .filter(r => r.oversupplySaturationFlag)
      .sort((a, b) => (b.importVsConsumptionGrowthGap ?? 0) - (a.importVsConsumptionGrowthGap ?? 0))
      .map(r => ({
        flowKey: this.seriesKey(r.flowType, r.reporterCountry, r.partnerCountry, r.nclCategory, r.hsChapter),
        importGrowthPct: r.yoyGrowthPct,
        consumptionGrowthPct: r.consumptionGrowthPct,
        gapPp: r.importVsConsumptionGrowthGap,
      }));

    return {
      acceleratingCategories,
      breakpointsDetected,
      oversupplySaturationFlags,
      topAcceleration,
      marketShareInsights,
      saturationWarnings,
    };
  }

  // ---------------------------------------------------------------------------
  // Comtrade API helpers
  // ---------------------------------------------------------------------------

  private async comtradeMonthlyQuery(
    reporterCode: number,
    partnerCode: number,
    flowCode: 'M' | 'X',
  ): Promise<ComtradeRow[]> {
    const url =
      'https://comtradeapi.un.org/public/v1/preview/C/M/HS' +
      `?reporterCode=${reporterCode}` +
      `&partnerCode=${partnerCode}` +
      `&period=${MONTHLY_PERIOD_PARAM}` +
      `&cmdCode=${ALL_HS_CHAPTERS}` +
      `&flowCode=${flowCode}` +
      `&customsCode=C00&motCode=0&partner2Code=0` +
      `&maxRecords=500`;

    const resp = await fetch(url, {
      headers: { 'User-Agent': 'NCL-MarketIntelligenceEngine/1.0 (research use)' },
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      throw new Error(`Comtrade monthly HTTP ${resp.status} for reporter=${reporterCode} partner=${partnerCode}`);
    }

    const json = (await resp.json()) as ComtradeResponse;
    return json.data ?? [];
  }

  private async comtradeAnnualQuery(
    reporterCode: number,
    partnerCode: number,
    yearsParam: string,
    flowCode: 'M' | 'X',
  ): Promise<ComtradeRow[]> {
    const url =
      'https://comtradeapi.un.org/public/v1/preview/C/A/HS' +
      `?reporterCode=${reporterCode}` +
      `&partnerCode=${partnerCode}` +
      `&period=${yearsParam}` +
      `&cmdCode=${ALL_HS_CHAPTERS}` +
      `&flowCode=${flowCode}` +
      `&customsCode=C00&motCode=0&partner2Code=0` +
      `&maxRecords=500`;

    const resp = await fetch(url, {
      headers: { 'User-Agent': 'NCL-MarketIntelligenceEngine/1.0 (research use)' },
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      throw new Error(`Comtrade annual HTTP ${resp.status} for reporter=${reporterCode} partner=${partnerCode}`);
    }

    const json = (await resp.json()) as ComtradeResponse;
    return json.data ?? [];
  }

  private parseMonthlyDataset(
    dataset: ComtradeRow[],
    flowType: string,
    reporterCountry: string,
    partnerCountry: string,
  ): Array<{
    flowType: string; reporterCountry: string; partnerCountry: string;
    nclCategory: string; hsChapter: string; yearMonth: number;
    tradeValueUsd: number | null; netWeightKg: number | null;
  }> {
    return dataset
      .map(row => {
        const code = String(row.cmdCode).replace(/\s/g, '');
        const chapter = code.startsWith('2106') ? '2106' : code.substring(0, 2);
        const category = chapter === '2106' ? 'supplements' : (CHAPTER_CATEGORY_MAP[chapter] ?? '');
        if (!category) return null;

        // Monthly rows have period as YYYYMM integer (or refYear + refMonth)
        const yearMonth: number = row.period
          ? row.period
          : (row.refYear ?? 0) * 100 + (row.refMonth ?? 0);
        if (yearMonth < 202201 || yearMonth > 202312) return null;

        return {
          flowType,
          reporterCountry,
          partnerCountry,
          nclCategory: category,
          hsChapter: chapter,
          yearMonth,
          tradeValueUsd: row.primaryValue > 0 ? row.primaryValue : null,
          netWeightKg: row.netWgt > 0 ? row.netWgt : null,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
  }

  // ---------------------------------------------------------------------------
  // Parse Eurostat nama_10_fcs JSON-stat response
  // ---------------------------------------------------------------------------

  private parseConsumptionResponse(
    json: Record<string, unknown>,
    nclCategory: string,
    map: Map<string, ConsumptionEntry[]>,
  ): void {
    try {
      const dimension = json['dimension'] as Record<string, unknown> | undefined;
      const values    = json['value'] as Record<string, number | null> | undefined;
      if (!dimension || !values) return;

      // Find geo and time dimension keys
      const geoDimKey  = Object.keys(dimension).find(k => k === 'geo');
      const timeDimKey = Object.keys(dimension).find(k => k === 'TIME_PERIOD' || k === 'time');
      if (!geoDimKey || !timeDimKey) return;

      const geoDim  = dimension[geoDimKey]  as { category: { index: Record<string, number>; label?: Record<string, string> } };
      const timeDim = dimension[timeDimKey] as { category: { index: Record<string, number> } };
      if (!geoDim?.category?.index || !timeDim?.category?.index) return;

      const geoIndex  = geoDim.category.index;   // { DE: 0, FR: 1, ... }
      const timeIndex = timeDim.category.index;  // { '2022': 0, '2023': 1 }
      const nGeo  = Object.keys(geoIndex).length;
      const nTime = Object.keys(timeIndex).length;

      for (const [geo, geoPos] of Object.entries(geoIndex)) {
        for (const [yearStr, timePos] of Object.entries(timeIndex)) {
          const year = parseInt(yearStr, 10);
          // Flat index: geo × time
          const flatIdx = geoPos * nTime + timePos;
          const val = values[String(flatIdx)];
          if (val == null) continue;

          const k = `${nclCategory}|${geo}`;
          if (!map.has(k)) map.set(k, []);
          const existing = map.get(k)!;
          if (!existing.some(e => e.year === year)) {
            existing.push({ year, eurMillions: val });
          }
        }
      }
    } catch {
      // Malformed JSON-stat — silently skip
    }
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  private seriesKey(
    flowType: string,
    reporterCountry: string,
    partnerCountry: string,
    nclCategory: string,
    hsChapter: string,
  ): string {
    return `${flowType}|${reporterCountry}|${partnerCountry}|${nclCategory}|${hsChapter}`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ---------------------------------------------------------------------------
// Internal analytics row type (shape matches tradeFlowAnalytics schema)
// ---------------------------------------------------------------------------

interface AnalyticsRow {
  flowType: string;
  reporterCountry: string;
  partnerCountry: string;
  nclCategory: string;
  hsChapter: string;
  asOfYear: number;
  yoyGrowthPct: number | null;
  cagr3yr: number | null;
  cagr5yr: number | null;
  avg6mUsd: number | null;
  avg12mUsd: number | null;
  shortTermMomentum: number | null;
  accelerationScore: number | null;
  isAccelerating: boolean;
  linearTrendSlope: number | null;
  rSquared: number | null;
  breakpointDetected: boolean;
  breakpointYear: number | null;
  breakpointType: string | null;
  firstHalfSlope: number | null;
  secondHalfSlope: number | null;
  usMarketSharePct: number | null;
  usMarketSharePriorPct: number | null;
  shareChangePct: number | null;
  shareTrend: string | null;
  chinaMarketSharePct: number | null;
  ukMarketSharePct: number | null;
  rowMarketSharePct: number | null;
  usVsChinaShareDiff: number | null;
  usGrowthVsMarketRatio: number | null;
  saturationRiskScore: number | null;
  euConsumptionEurM: number | null;
  importIntensityPct: number | null;
  consumptionGrowthPct: number | null;
  // ── Monthly OLS ───────────────────────────────────────────────────────────
  monthlyOlsSlope: number | null;
  monthlyOlsRSquared: number | null;
  // ── Monthly breakpoint scan ───────────────────────────────────────────────
  monthlyBreakpointMonth: number | null;
  // ── Oversupply saturation signal ──────────────────────────────────────────
  importVsConsumptionGrowthGap: number | null;
  oversupplySaturationFlag: boolean;
}

// ---------------------------------------------------------------------------
// Helper: round to 2 decimal places
// ---------------------------------------------------------------------------

function r(n: number): number {
  return Math.round(n * 100) / 100;
}
