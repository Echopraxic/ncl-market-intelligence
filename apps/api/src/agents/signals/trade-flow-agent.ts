// src/agents/signals/trade-flow-agent.ts
//
// TradeFlowIntelligenceAgent
//
// Collects 5-year (2019–2023) US↔EU trade intelligence across NCL's five target
// product categories using the UN Comtrade legacy API (free, no auth) as the
// primary source, with Eurostat COMEXT as a cross-validation supplement.
//
// ── Flow types collected ─────────────────────────────────────────────────────
//   1. PRIMARY   (us_to_eu)  — US exports to each NCL EU market.
//                              Establishes import volumes and demand baselines.
//   2. REVERSE   (eu_to_us)  — US imports from each NCL EU market.
//                              Reveals EU competitive export capability /
//                              market saturation signals.
//   3. TRIANGULAR (us_to_uk) — US exports to UK (leg 1 of NI routing).
//              + (uk_to_eu)  — UK re-exports to EU (leg 2).
//                              Exposes post-Brexit routing shifts that directly
//                              impact NCL's Northern Ireland value proposition.
//   4. EUROSTAT  (us_to_eu)  — EU-27 aggregate imports from US via Eurostat
//                              COMEXT API (cross-validation; non-fatal fallback).
//
// ── Derived metrics ──────────────────────────────────────────────────────────
//   - Unit value (USD/kg):  tradeValueUsd / netWeightKg → margin potential proxy
//   - YoY growth rate:      computed in-memory from multi-year series
//   - CAGR 2019→2023:       annualised 4-year growth for top-market summary
//
// ── API sources ──────────────────────────────────────────────────────────────
//   Primary:   UN Comtrade+ public preview API (free, no key)
//              https://comtradeapi.un.org/public/v1/preview/C/A/HS
//   Secondary: Eurostat COMEXT DS-045409 (EU-27 cross-validation, best-effort)
//
// ── API quota optimisation ───────────────────────────────────────────────────
//   - Multi-year batching:  period=2019,2020,2021,2022,2023 (1 call per reporter-partner)
//   - Chapter batching:     all 13 NCL HS chapters in one cmdCode= parameter
//   - Aggregate filter:     customsCode=C00&motCode=0&partner2Code=0 → exactly 13 rows/call
//   - Permanent cache:      historical years 2019-2022 stored indefinitely
//   - Rolling cache:        2023 data refreshed every 30 days
//   - Total fresh-run calls: 18 Comtrade + ~13 Eurostat = ~31 calls, ~50 s
//
// ── NCL target categories ────────────────────────────────────────────────────
//   food_beverage          HS chapters 16-24
//   toys_games             HS chapter 95
//   cosmetics_personal_care HS chapter 33
//   home_goods             HS chapter 94
//   supplements            HS chapter 30 + subheading 2106 (food preps NES)

import { db } from '../../db/index.js';
import { tradeFlowIntelligence, agentOutputs } from '../../db/schema.js';
import { and, eq, gte, inArray } from 'drizzle-orm';
import { logger } from '../../lib/logger.js';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** HS chapters per NCL strategic category */
const CHAPTER_CATEGORY_MAP: Record<string, string> = {
  '16': 'food_beverage',
  '17': 'food_beverage',
  '18': 'food_beverage',
  '19': 'food_beverage',
  '20': 'food_beverage',
  '21': 'food_beverage', // NB: 2106 subheading reclassified to supplements in parser
  '22': 'food_beverage',
  '23': 'food_beverage',
  '24': 'food_beverage',
  '30': 'supplements',
  '33': 'cosmetics_personal_care',
  '94': 'home_goods',
  '95': 'toys_games',
};

/**
 * All NCL HS chapters batched into a single Comtrade cc= parameter.
 * The 2106 subheading (within ch21) is identified in post-processing.
 */
const ALL_HS_CHAPTERS = '16,17,18,19,20,21,22,23,24,30,33,94,95';

/** NCL's 6 target EU markets: ISO-2 → UN Comtrade reporter code */
const EU_MARKETS: Record<string, number> = {
  DE: 276,
  FR: 251,
  NL: 528,
  ES: 724,
  IT: 381,
  GB: 826,
};

const US_REPORTER_CODE = 842;
const GB_REPORTER_CODE = 826;

/** 5-year historical window covering COVID disruption + post-Brexit period */
const YEARS = [2019, 2020, 2021, 2022, 2023] as const;
const YEARS_PARAM = YEARS.join(',');

/** Years that will never change — cache permanently (no TTL check) */
const PERMANENT_CACHE_YEARS = new Set([2019, 2020, 2021, 2022]);
const ROLLING_CACHE_TTL_DAYS = 30;

/** Comtrade+ public preview: no documented rate limit but we pace conservatively. */
const COMTRADE_RATE_LIMIT_MS = 1000;
/** Eurostat is more generous */
const EUROSTAT_RATE_LIMIT_MS = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Row shape returned by the Comtrade+ public preview endpoint */
interface ComtradeRow {
  cmdCode: string;
  refYear: number;
  flowCode: string;       // 'M' | 'X'
  reporterCode: number;
  partnerCode: number;
  partner2Code: number;   // 0 = World aggregate
  customsCode: string;    // 'C00' = total customs procedures
  motCode: number;        // 0 = total all modes of transport
  primaryValue: number;   // USD trade value
  netWgt: number;         // kg net weight (0 when not reported)
  cifvalue: number | null;
  fobvalue: number | null;
}

interface ComtradeResponse {
  count: number;
  data?: ComtradeRow[];
}

/** Internal working row before growth-rate computation */
interface RawTradeRow {
  id: string;
  flowType: string;
  reporterCountry: string;
  partnerCountry: string;
  nclCategory: string;
  hsChapter: string;
  year: number;
  tradeValueUsd: number | null;
  netWeightKg: number | null;
  unitValueUsdPerKg: number | null;
  source: 'comtrade' | 'eurostat';
}

/** Final row including computed YoY growth rate */
interface EnrichedTradeRow extends RawTradeRow {
  growthRateYoy: number | null;
}

export interface TradeFlowIntelligenceResult {
  rowsUpserted: number;
  flowBreakdown: Record<string, number>;
  topGrowthMarkets: Array<{ category: string; country: string; cagr2019to2023: number }>;
  brexitSignal: {
    ukImportsFromUS2019: number;
    ukImportsFromUS2023: number;
    changePercent: number;
  } | null;
  triangularRoutingSignal: Array<{
    euCountry: string;
    ukSourceSharePercent: number;
    year: number;
  }>;
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export class TradeFlowIntelligenceAgent {
  private readonly log = logger.child({ agent: 'TradeFlowIntelligenceAgent' });

  async run(forceRefresh = false): Promise<TradeFlowIntelligenceResult> {
    this.log.info({ forceRefresh }, '[TradeFlowAgent] Starting run');

    // Pre-load all cached keys in a single DB query to avoid N×5 per-year queries
    const cachedKeys = await this.loadCachedKeys(forceRefresh);

    const rawRows: RawTradeRow[] = [];

    rawRows.push(...await this.fetchPrimaryFlows(cachedKeys));
    rawRows.push(...await this.fetchReverseFlows(cachedKeys));
    rawRows.push(...await this.fetchTriangularFlows(cachedKeys));

    // Eurostat — non-fatal; skipped silently on any error
    try {
      rawRows.push(...await this.fetchEurostatFlows(cachedKeys));
    } catch (err) {
      this.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        '[TradeFlowAgent] Eurostat fetch failed — proceeding without it',
      );
    }

    const enriched = this.computeGrowthRates(rawRows);
    const upserted = await this.persist(enriched);
    const summary = this.buildIntelligenceSummary(enriched);

    await db.insert(agentOutputs).values({
      agentType: 'trade_flow_intelligence',
      outputData: {
        runAt: new Date().toISOString(),
        rowsCollected: rawRows.length,
        rowsUpserted: upserted,
        ...summary,
      },
      relatedEntityIds: [],
      createdAt: new Date(),
    });

    this.log.info({ rowsUpserted: upserted }, '[TradeFlowAgent] Run complete');
    return { rowsUpserted: upserted, ...summary };
  }

  // ---------------------------------------------------------------------------
  // Flow 1 — Primary: US exports to each NCL EU market
  //   Reporter = US (842), Partner = EU market, rg = 2 (exports)
  //   Establishes: baseline import volumes, growth patterns, unit values
  // ---------------------------------------------------------------------------

  private async fetchPrimaryFlows(cachedKeys: Set<string>): Promise<RawTradeRow[]> {
    const rows: RawTradeRow[] = [];

    for (const [countryCode, partnerCode] of Object.entries(EU_MARKETS)) {
      const years = this.uncachedYears('us_to_eu', 'US', countryCode, cachedKeys);
      if (years.length === 0) {
        this.log.debug({ countryCode }, '[TradeFlowAgent] Primary flow fully cached');
        continue;
      }

      try {
        this.log.info({ countryCode, years }, '[TradeFlowAgent] Fetching primary flow');
        const dataset = await this.comtradeQuery(US_REPORTER_CODE, partnerCode, years.join(','), 'X');
        rows.push(...this.parseComtradeDataset(dataset, 'us_to_eu', 'US', countryCode));
        await this.sleep(COMTRADE_RATE_LIMIT_MS);
      } catch (err) {
        this.log.warn(
          { countryCode, err: err instanceof Error ? err.message : String(err) },
          '[TradeFlowAgent] Primary flow query failed — skipping country',
        );
      }
    }

    return rows;
  }

  // ---------------------------------------------------------------------------
  // Flow 2 — Reverse: US imports from each NCL EU market
  //   Reporter = US (842), Partner = EU market, rg = 1 (imports into US)
  //   Signals: EU competitive export sophistication, product market saturation
  // ---------------------------------------------------------------------------

  private async fetchReverseFlows(cachedKeys: Set<string>): Promise<RawTradeRow[]> {
    const rows: RawTradeRow[] = [];

    for (const [countryCode, partnerCode] of Object.entries(EU_MARKETS)) {
      // We use US as reporter for consistency; rg=1 gives US imports = EU exports to US
      const years = this.uncachedYears('eu_to_us', countryCode, 'US', cachedKeys);
      if (years.length === 0) {
        this.log.debug({ countryCode }, '[TradeFlowAgent] Reverse flow fully cached');
        continue;
      }

      try {
        this.log.info({ countryCode, years }, '[TradeFlowAgent] Fetching reverse flow');
        // flowCode=M: US imports from EU (= EU exports to US)
        const dataset = await this.comtradeQuery(US_REPORTER_CODE, partnerCode, years.join(','), 'M');
        // reporter = EU country conceptually; partnerCountry = 'US' (the destination)
        rows.push(...this.parseComtradeDataset(dataset, 'eu_to_us', countryCode, 'US'));
        await this.sleep(COMTRADE_RATE_LIMIT_MS);
      } catch (err) {
        this.log.warn(
          { countryCode, err: err instanceof Error ? err.message : String(err) },
          '[TradeFlowAgent] Reverse flow query failed — skipping country',
        );
      }
    }

    return rows;
  }

  // ---------------------------------------------------------------------------
  // Flow 3 — Triangular: US→UK + UK→EU (post-Brexit NI routing intelligence)
  //
  //   Leg A: US→UK  Reporter = US, Partner = GB, rg = 2
  //          Captures total US goods entering the UK (potential NI entry point)
  //
  //   Leg B: UK→EU  Reporter = each continental EU market, Partner = GB, rg = 1
  //          Captures EU imports from UK — proxy for NI/GB goods re-entering EU.
  //          A rising UK source share signals NI dual-market routing is active.
  // ---------------------------------------------------------------------------

  private async fetchTriangularFlows(cachedKeys: Set<string>): Promise<RawTradeRow[]> {
    const rows: RawTradeRow[] = [];

    // Leg A: US → UK
    const usUkYears = this.uncachedYears('us_to_uk', 'US', 'GB', cachedKeys);
    if (usUkYears.length > 0) {
      try {
        this.log.info({ years: usUkYears }, '[TradeFlowAgent] Fetching US→UK triangular leg');
        const dataset = await this.comtradeQuery(US_REPORTER_CODE, GB_REPORTER_CODE, usUkYears.join(','), 'X');
        rows.push(...this.parseComtradeDataset(dataset, 'us_to_uk', 'US', 'GB'));
        await this.sleep(COMTRADE_RATE_LIMIT_MS);
      } catch (err) {
        this.log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          '[TradeFlowAgent] US→UK triangular query failed',
        );
      }
    }

    // Leg B: UK → each continental EU market
    const continentalEU = Object.entries(EU_MARKETS).filter(([code]) => code !== 'GB');
    for (const [euCountry, euReporterCode] of continentalEU) {
      const years = this.uncachedYears('uk_to_eu', 'GB', euCountry, cachedKeys);
      if (years.length === 0) {
        this.log.debug({ euCountry }, '[TradeFlowAgent] UK→EU triangular leg fully cached');
        continue;
      }

      try {
        this.log.info({ euCountry, years }, '[TradeFlowAgent] Fetching UK→EU triangular leg');
        // Reporter = EU country; flowCode=M (imports from GB); GB is the conceptual sender
        const dataset = await this.comtradeQuery(euReporterCode, GB_REPORTER_CODE, years.join(','), 'M');
        rows.push(...this.parseComtradeDataset(dataset, 'uk_to_eu', 'GB', euCountry));
        await this.sleep(COMTRADE_RATE_LIMIT_MS);
      } catch (err) {
        this.log.warn(
          { euCountry, err: err instanceof Error ? err.message : String(err) },
          '[TradeFlowAgent] UK→EU triangular query failed — skipping country',
        );
      }
    }

    return rows;
  }

  // ---------------------------------------------------------------------------
  // Eurostat COMEXT — EU-27 aggregate imports from US
  //   Dataset: DS-045409 | Reporter: EU27_2020 | Partner: US | Flow: 1 (import)
  //   Provides EU-perspective cross-validation for Comtrade primary flows.
  //   Non-fatal: any failure returns [] and logs a warning.
  // ---------------------------------------------------------------------------

  private async fetchEurostatFlows(cachedKeys: Set<string>): Promise<RawTradeRow[]> {
    const chapters = Object.keys(CHAPTER_CATEGORY_MAP);
    const uncachedYears = this.uncachedYears('us_to_eu', 'EUROSTAT', 'EU27', cachedKeys);
    if (uncachedYears.length === 0) {
      this.log.debug('[TradeFlowAgent] Eurostat flows fully cached');
      return [];
    }

    const rows: RawTradeRow[] = [];

    for (const chapter of chapters) {
      try {
        const url = this.buildEurostatUrl(chapter, uncachedYears);
        const resp = await fetch(url, {
          headers: {
            Accept: 'application/json',
            'User-Agent': 'NCL-MarketIntelligenceEngine/1.0 (research use)',
          },
          signal: AbortSignal.timeout(20_000),
        });

        if (!resp.ok) {
          this.log.debug({ chapter, status: resp.status }, '[TradeFlowAgent] Eurostat non-OK, skipping chapter');
          continue;
        }

        const json = (await resp.json()) as Record<string, unknown>;
        rows.push(...this.parseEurostatResponse(json, chapter, uncachedYears));
        await this.sleep(EUROSTAT_RATE_LIMIT_MS);
      } catch (err) {
        this.log.debug(
          { chapter, err: err instanceof Error ? err.message : String(err) },
          '[TradeFlowAgent] Eurostat chapter fetch failed — skipping',
        );
      }
    }

    return rows;
  }

  // ---------------------------------------------------------------------------
  // Comtrade+ public preview API
  //   Endpoint: https://comtradeapi.un.org/public/v1/preview/C/A/HS
  //   Aggregate filter params applied in URL:
  //     customsCode=C00  → total all customs procedures
  //     motCode=0        → total all modes of transport (also captures MOT signal)
  //     partner2Code=0   → no secondary partner breakdown
  //   Result: exactly 1 row per (reporter, partner, cmdCode, year).
  //   flowCode: 'M' = imports, 'X' = exports
  // ---------------------------------------------------------------------------

  private async comtradeQuery(
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

    this.log.debug(
      { reporter: reporterCode, partner: partnerCode, flowCode, years: yearsParam },
      '[TradeFlowAgent] Comtrade+ query',
    );

    const resp = await fetch(url, {
      headers: { 'User-Agent': 'NCL-MarketIntelligenceEngine/1.0 (research use)' },
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      throw new Error(`Comtrade+ HTTP ${resp.status} for reporter=${reporterCode} partner=${partnerCode}`);
    }

    const json = (await resp.json()) as ComtradeResponse;
    return json.data ?? [];
  }

  // ---------------------------------------------------------------------------
  // Parse Comtrade+ aggregate rows into RawTradeRows.
  //   With customsCode=C00/motCode=0/partner2Code=0 applied at query time,
  //   each row is already the clean aggregate — no post-grouping needed.
  //   Special case: cmdCode '21' / subheading '2106' → supplements.
  // ---------------------------------------------------------------------------

  private parseComtradeDataset(
    dataset: ComtradeRow[],
    flowType: string,
    reporterCountry: string,
    partnerCountry: string,
  ): RawTradeRow[] {
    return dataset
      .map(row => {
        const code = String(row.cmdCode).replace(/\s/g, '');
        const chapter = code.startsWith('2106') ? '2106' : code.substring(0, 2);
        const category =
          chapter === '2106' ? 'supplements' : (CHAPTER_CATEGORY_MAP[chapter] ?? '');
        if (!category) return null;

        const tradeValueUsd = row.primaryValue > 0 ? row.primaryValue : null;
        const netWeightKg = row.netWgt > 0 ? row.netWgt : null;
        const unitValueUsdPerKg =
          tradeValueUsd != null && netWeightKg != null
            ? Math.round((tradeValueUsd / netWeightKg) * 100) / 100
            : null;

        return {
          id: randomUUID() as string,
          flowType,
          reporterCountry,
          partnerCountry,
          nclCategory: category,
          hsChapter: chapter,
          year: row.refYear,
          tradeValueUsd,
          netWeightKg,
          unitValueUsdPerKg,
          source: 'comtrade' as const,
        } satisfies RawTradeRow;
      })
      .filter((r) => r !== null) as RawTradeRow[];
  }

  // ---------------------------------------------------------------------------
  // Eurostat URL builder (COMEXT dataset DS-045409)
  //   REPORTER: EU27_2020  PARTNER: US  FLOW: 1 (imports)  PRODUCT: HS chapter
  // ---------------------------------------------------------------------------

  private buildEurostatUrl(chapter: string, years: number[]): string {
    const periodParam = years.map(y => `time=${y}`).join('&');
    return (
      'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/DS-045409' +
      '?format=JSON&lang=en' +
      '&REPORTER=EU27_2020&PARTNER=US&FLOW=1' +
      `&PRODUCT=${chapter}` +
      `&${periodParam}`
    );
  }

  // ---------------------------------------------------------------------------
  // Parse Eurostat JSON-stat response (best-effort)
  //   JSON-stat encodes dimension indices and values as flat arrays.
  //   If the structure is unexpected, we return [] rather than throwing.
  // ---------------------------------------------------------------------------

  private parseEurostatResponse(
    json: Record<string, unknown>,
    chapter: string,
    years: number[],
  ): RawTradeRow[] {
    const rows: RawTradeRow[] = [];
    const nclCategory = CHAPTER_CATEGORY_MAP[chapter];
    if (!nclCategory) return rows;

    try {
      const dimension = json['dimension'] as Record<string, unknown> | undefined;
      const values = json['value'] as Record<string, number | null> | undefined;
      if (!dimension || !values) return rows;

      // Find the time dimension (Eurostat uses 'TIME_PERIOD' or 'time')
      const timeDimKey = Object.keys(dimension).find(k =>
        k === 'TIME_PERIOD' || k.toLowerCase() === 'time',
      );
      if (!timeDimKey) return rows;

      const timeDim = dimension[timeDimKey] as {
        category: { index: Record<string, number>; label: Record<string, string> };
      };
      if (!timeDim?.category?.index) return rows;

      const timeIndex = timeDim.category.index; // { '2019': 0, '2020': 1, ... }
      const timeDimSize = Object.keys(timeIndex).length;

      for (const [yearStr, posInTime] of Object.entries(timeIndex)) {
        const year = parseInt(yearStr, 10);
        if (!years.includes(year)) continue;

        // Sum all value entries that fall at this time position
        // For single-product queries the value array maps directly to time positions
        let totalEur = 0;
        let hasValue = false;
        for (const [idxStr, val] of Object.entries(values)) {
          if (val == null) continue;
          const idx = parseInt(idxStr, 10);
          if (timeDimSize > 0 && idx % timeDimSize === posInTime) {
            totalEur += val;
            hasValue = true;
          }
        }

        if (hasValue && totalEur > 0) {
          // Eurostat values are in EUR thousands; convert to USD (approx 1.08 EUR/USD)
          const tradeValueUsd = Math.round(totalEur * 1000 * 1.08);
          rows.push({
            id: randomUUID(),
            flowType: 'us_to_eu',
            reporterCountry: 'EUROSTAT',
            partnerCountry: 'EU27',
            nclCategory,
            hsChapter: chapter,
            year,
            tradeValueUsd,
            netWeightKg: null,
            unitValueUsdPerKg: null,
            source: 'eurostat' as const,
          });
        }
      }
    } catch {
      // Malformed response — return what we have
    }

    return rows;
  }

  // ---------------------------------------------------------------------------
  // Compute YoY growth rates from the multi-year series in-memory
  //   Groups rows by (flowType, reporter, partner, category, chapter) and
  //   calculates: growthRateYoy = (currentValue / priorValue - 1) × 100
  // ---------------------------------------------------------------------------

  private computeGrowthRates(rows: RawTradeRow[]): EnrichedTradeRow[] {
    type SeriesKey = string;
    const grouped = new Map<SeriesKey, RawTradeRow[]>();

    for (const row of rows) {
      const key: SeriesKey =
        `${row.flowType}|${row.reporterCountry}|${row.partnerCountry}|${row.nclCategory}|${row.hsChapter}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(row);
    }

    const enriched: EnrichedTradeRow[] = [];

    for (const seriesRows of grouped.values()) {
      const sorted = [...seriesRows].sort((a, b) => a.year - b.year);
      const valueByYear = new Map(sorted.map(r => [r.year, r.tradeValueUsd]));

      for (const row of sorted) {
        const prevValue = valueByYear.get(row.year - 1) ?? null;
        let growthRateYoy: number | null = null;

        if (prevValue != null && prevValue > 0 && row.tradeValueUsd != null) {
          growthRateYoy =
            Math.round(((row.tradeValueUsd - prevValue) / prevValue) * 10000) / 100;
        }

        enriched.push({ ...row, growthRateYoy });
      }
    }

    return enriched;
  }

  // ---------------------------------------------------------------------------
  // Persist to DB using upsert (ON CONFLICT DO UPDATE)
  // ---------------------------------------------------------------------------

  private async persist(rows: EnrichedTradeRow[]): Promise<number> {
    let upserted = 0;

    for (const row of rows) {
      try {
        await db
          .insert(tradeFlowIntelligence)
          .values({
            id: row.id,
            flowType: row.flowType,
            reporterCountry: row.reporterCountry,
            partnerCountry: row.partnerCountry,
            nclCategory: row.nclCategory,
            hsChapter: row.hsChapter,
            year: row.year,
            tradeValueUsd: row.tradeValueUsd,
            netWeightKg: row.netWeightKg,
            unitValueUsdPerKg: row.unitValueUsdPerKg,
            growthRateYoy: row.growthRateYoy,
            source: row.source,
            fetchedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [
              tradeFlowIntelligence.flowType,
              tradeFlowIntelligence.reporterCountry,
              tradeFlowIntelligence.partnerCountry,
              tradeFlowIntelligence.nclCategory,
              tradeFlowIntelligence.hsChapter,
              tradeFlowIntelligence.year,
            ],
            set: {
              tradeValueUsd: row.tradeValueUsd,
              netWeightKg: row.netWeightKg,
              unitValueUsdPerKg: row.unitValueUsdPerKg,
              growthRateYoy: row.growthRateYoy,
              source: row.source,
              fetchedAt: new Date(),
            },
          });
        upserted++;
      } catch (err) {
        this.log.warn(
          {
            flow: row.flowType,
            country: row.partnerCountry,
            category: row.nclCategory,
            year: row.year,
            err: err instanceof Error ? err.message : String(err),
          },
          '[TradeFlowAgent] Upsert failed for row',
        );
      }
    }

    return upserted;
  }

  // ---------------------------------------------------------------------------
  // Intelligence summary (returned to caller + stored in agent_outputs)
  // ---------------------------------------------------------------------------

  private buildIntelligenceSummary(
    rows: EnrichedTradeRow[],
  ): Omit<TradeFlowIntelligenceResult, 'rowsUpserted'> {
    // ── Flow breakdown (row counts per type) ────────────────────────────────
    const flowBreakdown: Record<string, number> = {};
    for (const row of rows) {
      flowBreakdown[row.flowType] = (flowBreakdown[row.flowType] ?? 0) + 1;
    }

    // ── Top growth markets: CAGR 2019→2023 for primary us_to_eu Comtrade flows ─
    const primaryComtrade = rows.filter(
      r => r.flowType === 'us_to_eu' && r.source === 'comtrade',
    );

    type V2019V2023 = { v2019: number | null; v2023: number | null };
    const seriesMap = new Map<string, V2019V2023>();

    for (const row of primaryComtrade) {
      const key = `${row.nclCategory}:${row.partnerCountry}`;
      const entry = seriesMap.get(key) ?? { v2019: null, v2023: null };
      if (row.year === 2019) entry.v2019 = row.tradeValueUsd;
      if (row.year === 2023) entry.v2023 = row.tradeValueUsd;
      seriesMap.set(key, entry);
    }

    const topGrowthMarkets = Array.from(seriesMap.entries())
      .filter(([, v]) => v.v2019 != null && v.v2019 > 0 && v.v2023 != null && v.v2023 > 0)
      .map(([key, v]) => {
        const [category, country] = key.split(':');
        // CAGR = (v2023/v2019)^(1/4) − 1, expressed as %
        const cagr =
          Math.round((Math.pow(v.v2023! / v.v2019!, 1 / 4) - 1) * 10000) / 100;
        return { category, country, cagr2019to2023: cagr };
      })
      .sort((a, b) => b.cagr2019to2023 - a.cagr2019to2023)
      .slice(0, 10);

    // ── Brexit signal: US→UK total trade value change 2019→2023 ─────────────
    const usToUkRows = rows.filter(r => r.flowType === 'us_to_uk');
    const uk2019 = usToUkRows
      .filter(r => r.year === 2019)
      .reduce((s, r) => s + (r.tradeValueUsd ?? 0), 0);
    const uk2023 = usToUkRows
      .filter(r => r.year === 2023)
      .reduce((s, r) => s + (r.tradeValueUsd ?? 0), 0);

    const brexitSignal =
      uk2019 > 0 && uk2023 > 0
        ? {
            ukImportsFromUS2019: uk2019,
            ukImportsFromUS2023: uk2023,
            changePercent: Math.round(((uk2023 - uk2019) / uk2019) * 10000) / 100,
          }
        : null;

    // ── Triangular routing signal: UK source share per EU country (2023) ────
    //   = ukToEu volume / (ukToEu + usToEu) for each continental EU market
    const ukToEu2023 = rows.filter(r => r.flowType === 'uk_to_eu' && r.year === 2023);
    const usToEu2023 = rows.filter(
      r => r.flowType === 'us_to_eu' && r.year === 2023 && r.source === 'comtrade',
    );

    const euCountries = [...new Set(ukToEu2023.map(r => r.partnerCountry))];
    const triangularRoutingSignal = euCountries
      .map(euCountry => {
        const ukVol = ukToEu2023
          .filter(r => r.partnerCountry === euCountry)
          .reduce((s, r) => s + (r.tradeValueUsd ?? 0), 0);
        const usVol = usToEu2023
          .filter(r => r.partnerCountry === euCountry)
          .reduce((s, r) => s + (r.tradeValueUsd ?? 0), 0);
        const total = ukVol + usVol;
        if (total === 0) return null;
        return {
          euCountry,
          ukSourceSharePercent: Math.round((ukVol / total) * 10000) / 100,
          year: 2023,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => b.ukSourceSharePercent - a.ukSourceSharePercent);

    return { flowBreakdown, topGrowthMarkets, brexitSignal, triangularRoutingSignal };
  }

  // ---------------------------------------------------------------------------
  // Cache helpers
  // ---------------------------------------------------------------------------

  /**
   * Load all existing (flowType, reporter, partner, year) tuples in one query.
   * Returns a Set<string> of keys in format `{flowType}|{reporter}|{partner}|{year}`.
   */
  private async loadCachedKeys(forceRefresh: boolean): Promise<Set<string>> {
    if (forceRefresh) return new Set();

    const cutoff30Days = new Date();
    cutoff30Days.setDate(cutoff30Days.getDate() - ROLLING_CACHE_TTL_DAYS);

    const existingRows = await db
      .select({
        flowType: tradeFlowIntelligence.flowType,
        reporterCountry: tradeFlowIntelligence.reporterCountry,
        partnerCountry: tradeFlowIntelligence.partnerCountry,
        year: tradeFlowIntelligence.year,
        fetchedAt: tradeFlowIntelligence.fetchedAt,
      })
      .from(tradeFlowIntelligence)
      .where(inArray(tradeFlowIntelligence.year, [...YEARS]));

    const keys = new Set<string>();
    for (const row of existingRows) {
      const isPermanent = PERMANENT_CACHE_YEARS.has(row.year);
      const isRecent = row.fetchedAt >= cutoff30Days;

      if (isPermanent || isRecent) {
        keys.add(`${row.flowType}|${row.reporterCountry}|${row.partnerCountry}|${row.year}`);
      }
    }

    return keys;
  }

  /** Returns years not yet in the cache for a given (flowType, reporter, partner). */
  private uncachedYears(
    flowType: string,
    reporterCountry: string,
    partnerCountry: string,
    cachedKeys: Set<string>,
  ): number[] {
    return YEARS.filter(
      year => !cachedKeys.has(`${flowType}|${reporterCountry}|${partnerCountry}|${year}`),
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
