// src/lib/trade-flow-client.ts
//
// Fetches US import reliance data for taxonomy categories from free public APIs.
//
// Strategy:
//   1. Check tradeFlowData table — reuse cached rows younger than CACHE_TTL_DAYS.
//   2. Batch-query UN Comtrade legacy API (free, no key, 100 req/hour).
//      One call per (reporter country × flow direction) retrieves ALL HS codes at once.
//   3. Fall back to per-category static estimates from hs-code-mapping.json
//      when Comtrade is rate-limited or returns no data.
//
// Comtrade legacy endpoint:
//   GET https://comtrade.un.org/api/get
//     ?type=C&freq=A&px=HS&ps={year}&r={reporterCode}&p={partnerCode}&rg=1&cc={hs1,hs2,...}
//
// import_reliance = us_imports_value / total_world_imports_value  (0–1)

import { db } from '../db/index.js';
import { tradeFlowData } from '../db/schema.js';
import { and, eq, gte } from 'drizzle-orm';
import { createRequire } from 'module';
import { logger } from './logger.js';

const require = createRequire(import.meta.url);
const hsMapping: HsMappingFile = require('../config/hs-code-mapping.json');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HsMappingEntry {
  primary: string;
  fallback: string;
  fallbackImportReliance: number;
}

interface HsMappingFile {
  categories: Record<string, HsMappingEntry>;
  _defaultFallbackImportReliance: number;
}

interface ComtradeRow {
  cmdCode: string;
  TradeValue: number;
  rtCode: number;
  ptCode: number;
  yr: number;
}

interface ComtradeResponse {
  validation?: { status?: { name?: string } };
  dataset: ComtradeRow[];
}

export interface TradeFlowResult {
  countryCode: string;
  category: string;
  importReliance: number;
  usImportsEurMillions: number | null;
  totalImportsEurMillions: number | null;
  source: 'comtrade' | 'cache' | 'fallback';
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_TTL_DAYS = 30;

/** ISO-2 → UN Comtrade reporter code */
const REPORTER_CODES: Record<string, number> = {
  DE: 276,
  FR: 251,
  NL: 528,
  GB: 826,
  ES: 724,
  IT: 381,
};

/** USA partner code */
const USA_PARTNER = 842;
/** World (all partners) */
const WORLD_PARTNER = 0;

// ---------------------------------------------------------------------------
// Main client
// ---------------------------------------------------------------------------

export class TradeFlowClient {
  private readonly rateLimitMs = 2000; // 2 s between Comtrade calls (stays well under 100/hour)

  /**
   * Returns import reliance (0–1) for every requested (category, countryCode) pair.
   * Results are cached in tradeFlowData for CACHE_TTL_DAYS days.
   */
  async fetchImportReliance(
    pairs: Array<{ category: string; countryCode: string }>,
  ): Promise<Map<string, TradeFlowResult>> {
    const results = new Map<string, TradeFlowResult>();
    const uncached: Array<{ category: string; countryCode: string }> = [];

    // -----------------------------------------------------------------------
    // 1. Serve from cache where possible
    // -----------------------------------------------------------------------

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - CACHE_TTL_DAYS);
    const currentYear = new Date().getFullYear() - 1; // Comtrade lags 1 year

    for (const pair of pairs) {
      const [row] = await db
        .select()
        .from(tradeFlowData)
        .where(
          and(
            eq(tradeFlowData.countryCode, pair.countryCode),
            eq(tradeFlowData.category, pair.category),
            eq(tradeFlowData.periodYear, currentYear),
            gte(tradeFlowData.fetchedAt, cutoff),
          ),
        )
        .limit(1);

      if (row) {
        results.set(`${pair.countryCode}:${pair.category}`, {
          countryCode: pair.countryCode,
          category: pair.category,
          importReliance: row.importReliance,
          usImportsEurMillions: row.usImportsEurMillions ?? null,
          totalImportsEurMillions: row.totalImportsEurMillions ?? null,
          source: 'cache',
        });
      } else {
        uncached.push(pair);
      }
    }

    if (uncached.length === 0) return results;

    // -----------------------------------------------------------------------
    // 2. Batch Comtrade queries grouped by country
    // -----------------------------------------------------------------------

    const byCountry = new Map<string, Set<string>>();
    for (const pair of uncached) {
      if (!byCountry.has(pair.countryCode)) byCountry.set(pair.countryCode, new Set());
      const entry = hsMapping.categories[pair.category];
      if (entry) {
        byCountry.get(pair.countryCode)!.add(entry.primary);
        byCountry.get(pair.countryCode)!.add(entry.fallback);
      }
    }

    // Keyed by `{reporterCode}:{hsCode}` → { usValue, worldValue }
    const comtradeData = new Map<string, { usValue: number; worldValue: number }>();

    for (const [countryCode, hsCodes] of byCountry) {
      const reporterCode = REPORTER_CODES[countryCode];
      if (!reporterCode) continue;

      const hsParam = Array.from(hsCodes).join(',');

      try {
        // US imports
        const usRows = await this.comtradeQuery(reporterCode, USA_PARTNER, hsParam, currentYear);
        for (const row of usRows) {
          const key = `${reporterCode}:${row.cmdCode}`;
          const existing = comtradeData.get(key) ?? { usValue: 0, worldValue: 0 };
          existing.usValue = row.TradeValue;
          comtradeData.set(key, existing);
        }

        await this.sleep(this.rateLimitMs);

        // World imports
        const worldRows = await this.comtradeQuery(reporterCode, WORLD_PARTNER, hsParam, currentYear);
        for (const row of worldRows) {
          const key = `${reporterCode}:${row.cmdCode}`;
          const existing = comtradeData.get(key) ?? { usValue: 0, worldValue: 0 };
          existing.worldValue = row.TradeValue;
          comtradeData.set(key, existing);
        }

        await this.sleep(this.rateLimitMs);
      } catch (err) {
        logger.warn(
          { countryCode, error: err instanceof Error ? err.message : String(err) },
          '[TradeFlowClient] Comtrade query failed — will use fallback for this country',
        );
      }
    }

    // -----------------------------------------------------------------------
    // 3. Resolve results for uncached pairs and persist to DB
    // -----------------------------------------------------------------------

    for (const pair of uncached) {
      const key = `${pair.countryCode}:${pair.category}`;
      const entry = hsMapping.categories[pair.category];
      const reporterCode = REPORTER_CODES[pair.countryCode];

      let importReliance: number;
      let usImports: number | null = null;
      let totalImports: number | null = null;
      let source: 'comtrade' | 'fallback' = 'fallback';

      if (entry && reporterCode) {
        // Try primary HS code, then fallback
        const primaryKey = `${reporterCode}:${entry.primary}`;
        const fallbackKey = `${reporterCode}:${entry.fallback}`;
        const data = comtradeData.get(primaryKey) ?? comtradeData.get(fallbackKey);

        if (data && data.worldValue > 0) {
          usImports = data.usValue / 1_000_000;       // USD → millions (approx EUR)
          totalImports = data.worldValue / 1_000_000;
          importReliance = Math.min(data.usValue / data.worldValue, 1);
          source = 'comtrade';
        } else {
          importReliance = entry.fallbackImportReliance;
        }
      } else {
        importReliance = hsMapping._defaultFallbackImportReliance;
      }

      results.set(key, {
        countryCode: pair.countryCode,
        category: pair.category,
        importReliance,
        usImportsEurMillions: usImports,
        totalImportsEurMillions: totalImports,
        source,
      });

      // Persist to cache (upsert pattern: insert, ignore conflict)
      try {
        await db.insert(tradeFlowData).values({
          countryCode: pair.countryCode,
          category: pair.category,
          periodYear: currentYear,
          usImportsEurMillions: usImports,
          totalImportsEurMillions: totalImports,
          importReliance,
          source,
          fetchedAt: new Date(),
        });
      } catch {
        // Row may already exist from a concurrent run — safe to ignore
      }
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async comtradeQuery(
    reporterCode: number,
    partnerCode: number,
    hsCodes: string,
    year: number,
  ): Promise<ComtradeRow[]> {
    const url =
      `https://comtrade.un.org/api/get` +
      `?type=C&freq=A&px=HS&ps=${year}` +
      `&r=${reporterCode}&p=${partnerCode}` +
      `&rg=1&cc=${hsCodes}&max=500&fmt=json`;

    const resp = await fetch(url, {
      headers: { 'User-Agent': 'NCL-MarketIntelligenceEngine/1.0 (research use)' },
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      throw new Error(`Comtrade HTTP ${resp.status} for reporter=${reporterCode}`);
    }

    const json = (await resp.json()) as ComtradeResponse;

    // Comtrade returns validation.status.name = 'Ok' on success
    if (json.validation?.status?.name && json.validation.status.name !== 'Ok') {
      logger.warn(
        { status: json.validation.status.name, reporterCode, partnerCode },
        '[TradeFlowClient] Comtrade non-OK validation status',
      );
    }

    return json.dataset ?? [];
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
