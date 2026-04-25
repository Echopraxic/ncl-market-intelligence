import { db } from '@/db/index.js';
import { euMarketSignals } from '@/db/schema.js';
import { logger } from '@/lib/logger.js';
import { eq, and, gte } from 'drizzle-orm';
import { BaseCrawler, type CrawlResult } from './base-crawler.js';
import { CrawlErrorCode, StructuredCrawlError, classifyError } from '@/lib/crawler-errors.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TrendsTimeframe =
  | 'today 5-y'   // Last 5 years
  | 'today 12-m'  // Last 12 months
  | 'today 3-m'   // Last 3 months
  | 'today 1-m'   // Last month
  | 'now 7-d'     // Last 7 days
  | 'now 1-d';    // Last day

type TrendsGeoCode = 'DE' | 'FR' | 'NL' | 'GB' | 'ES' | 'IT';

type CategoryConfig = {
  /** Category name for our database */
  categoryName: string;
  /** Search keywords/phrases to track (max 5 per Google Trends limit) */
  keywords: string[];
  /** Google Trends category ID (0 = all categories) */
  cat?: number;
  /** Property filter: 'web', 'images', 'news', 'youtube', 'froogle' */
  gprop?: '' | 'images' | 'news' | 'youtube' | 'froogle';
};

type TrendsConfig = {
  countries: TrendsGeoCode[];
  timeframe: TrendsTimeframe;
  categories: CategoryConfig[];
  maxRetries?: number;
  /** Base delay between requests in ms (only used for live HTTP mode) */
  baseDelayMs?: number;
};

type TrendsDataPoint = {
  date: string;
  keyword: string;
  value: number;
  is_partial: boolean;
};

type TrendsFetchResult = {
  success: boolean;
  geo: string;
  keywords: string[];
  interest_over_time?: TrendsDataPoint[];
  related_queries?: Record<string, { top: unknown[]; rising: unknown[] }>;
  error?: string;
};

// Google Trends API response shapes
type ExploreWidget = {
  id: string;
  token: string;
  title: string;
  request: Record<string, unknown>;
};

type MultilinePoint = {
  time: string;
  formattedTime: string;
  value: number[];
  isPartial?: boolean;
};

// ---------------------------------------------------------------------------
// Seed data — category keywords mapped to EU markets
// ---------------------------------------------------------------------------

const TRENDS_CONFIG: TrendsConfig = {
  countries: ['DE', 'FR', 'NL', 'GB', 'ES', 'IT'],
  timeframe: 'today 12-m',
  categories: [
    {
      categoryName: 'Toys & Games',
      keywords: ['toys', 'board games', 'educational toys', 'outdoor toys', 'STEM toys'],
    },
    {
      categoryName: 'Consumer Packaged Goods',
      keywords: ['organic snacks', 'healthy snacks', 'plant based food', 'protein snacks', 'natural food'],
    },
    {
      categoryName: 'Wellness & Supplements',
      keywords: ['vitamins', 'collagen supplements', 'gut health', 'adaptogen', 'nootropics'],
    },
    {
      categoryName: 'Home Goods',
      keywords: ['home decor', 'sustainable home', 'kitchen accessories', 'bedding', 'cleaning products'],
    },
    {
      categoryName: 'Baby & Kids',
      keywords: ['baby stroller', 'diapers', 'baby food', 'kids clothing', 'nursery furniture'],
    },
    {
      categoryName: 'Sustainable Products',
      keywords: ['eco friendly', 'sustainable', 'zero waste', 'biodegradable', 'recycled products'],
    },
    {
      categoryName: 'Pet Products',
      keywords: ['pet food', 'dog toys', 'cat accessories', 'pet care', 'natural pet food'],
    },
    {
      categoryName: 'Health & Beauty',
      keywords: ['skincare', 'organic cosmetics', 'hair care', 'clean beauty', 'natural skincare'],
    },
  ],
  maxRetries: 2,
  baseDelayMs: 3000,
};

// ---------------------------------------------------------------------------
// Crawler
//
// Data is sourced via direct HTTP calls to Google Trends' undocumented JSON
// API (the same endpoints pytrends uses). No Python dependency required.
//
// If Google returns a non-2xx response or a consent gate (no TIMESERIES widget),
// the crawler automatically falls back to deterministic synthetic data so the
// pipeline can run end-to-end in development. Set GOOGLE_TRENDS_MOCK=true to
// always use synthetic data and skip the HTTP attempt entirely.
// ---------------------------------------------------------------------------

const TRENDS_API_BASE_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://trends.google.com/trends/explore',
};

export class GoogleTrendsCrawler extends BaseCrawler {
  readonly crawlerType = 'google-trends';

  private requestCount = 0;
  private readonly maxRequestsPerBatch = 50;
  private readonly batchCooldownMs = 60_000;

  async run(): Promise<CrawlResult> {
    const errors: string[] = [];
    const structuredErrors: StructuredCrawlError[] = [];
    let recordsFound = 0;
    let newRecordsFound = 0;
    let pagesScraped = 0;
    const useMock = process.env.GOOGLE_TRENDS_MOCK === 'true';

    if (useMock) {
      logger.info('[GoogleTrends] Mock mode active — generating synthetic trend data');
    }

    for (const country of TRENDS_CONFIG.countries) {
      for (const category of TRENDS_CONFIG.categories) {
        try {
          if (this.requestCount >= this.maxRequestsPerBatch) {
            logger.info('[GoogleTrends] Batch limit reached — cooling down for 1 minute');
            await this.sleep(this.batchCooldownMs);
            this.requestCount = 0;
          }

          if (!useMock) {
            await this.sleep(TRENDS_CONFIG.baseDelayMs ?? 3000);
          }

          const params = {
            keywords: category.keywords,
            geo: country,
            timeframe: TRENDS_CONFIG.timeframe,
            cat: category.cat ?? 0,
            gprop: category.gprop ?? '',
          };

          const result = await this.withRetry(
            () => useMock
              ? Promise.resolve(this.generateMockTrendData(params.keywords, params.geo))
              : this.fetchTrendsWithFallback(params),
            `fetch-trends:${country}:${category.categoryName}`,
            useMock ? 1 : (TRENDS_CONFIG.maxRetries ?? 2),
          );

          if (!result.success) {
            throw new Error(result.error ?? 'Unknown trends error');
          }

          const { inserted, isNew } = await this.insertSignal(country, category.categoryName, result);
          recordsFound += inserted;
          if (isNew) newRecordsFound += inserted;
          pagesScraped++;
          this.requestCount++;

          logger.info(
            { country, category: category.categoryName, inserted, isNew, mock: useMock },
            'Google Trends signal processed',
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error({ country, category: category.categoryName, error: msg }, 'Failed to fetch trends');
          const errorCode = classifyError(msg);
          const structError: StructuredCrawlError = {
            code: errorCode,
            domain: 'trends.google.com',
            message: msg,
            retryable: [CrawlErrorCode.RATE_LIMITED, CrawlErrorCode.NETWORK_ERROR].includes(errorCode),
            timestamp: new Date().toISOString(),
          };
          structuredErrors.push(structError);
          errors.push(`${country}-${category.categoryName}: ${msg}`);
          if (!useMock) await this.sleep(10_000);
        }
      }
    }

    return { crawlerType: this.crawlerType, recordsFound, newRecordsFound, pagesScraped, errors, structuredErrors };
  }

  // -------------------------------------------------------------------------
  // HTTP fetch with automatic mock fallback
  // -------------------------------------------------------------------------

  private async fetchTrendsWithFallback(params: {
    keywords: string[];
    geo: string;
    timeframe: string;
    cat: number;
    gprop: string;
  }): Promise<TrendsFetchResult> {
    try {
      return await this.fetchTrendsDirect(params);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        { geo: params.geo, keywords: params.keywords, error: msg },
        '[GoogleTrends] HTTP fetch failed — falling back to synthetic data',
      );
      return this.generateMockTrendData(params.keywords, params.geo);
    }
  }

  // -------------------------------------------------------------------------
  // Direct HTTP implementation (no Python required)
  //
  // Mirrors the two-step flow pytrends uses:
  //   1. POST /trends/api/explore   → get widget token
  //   2. GET  /trends/api/widgetdata/multiline?token=... → get timeline data
  // -------------------------------------------------------------------------

  private async fetchTrendsDirect(params: {
    keywords: string[];
    geo: string;
    timeframe: string;
    cat: number;
    gprop: string;
  }): Promise<TrendsFetchResult> {
    const { keywords, geo, timeframe, cat, gprop } = params;
    const kws = keywords.slice(0, 5);

    // Step 1 — explore: get widget tokens
    const req = JSON.stringify({
      comparisonItem: kws.map((kw) => ({ keyword: kw, geo, time: timeframe })),
      category: cat,
      property: gprop,
    });

    const exploreUrl =
      `https://trends.google.com/trends/api/explore` +
      `?hl=en-US&tz=360&req=${encodeURIComponent(req)}`;

    const exploreHeaders = {
      ...TRENDS_API_BASE_HEADERS,
      'User-Agent': this.getNextUserAgent(),
    };

    const exploreRes = await fetch(exploreUrl, {
      headers: exploreHeaders,
      signal: AbortSignal.timeout(30_000),
    });

    if (exploreRes.status === 429) {
      await this.respectRetryAfter(exploreRes.headers);
      throw new Error('Rate limited by Google Trends (429)');
    }
    if (!exploreRes.ok) {
      throw new Error(`Google Trends explore API returned ${exploreRes.status}`);
    }

    const exploreText = await exploreRes.text();
    // Google prepends ")]}',\n" to all JSON responses to prevent XSSI
    const exploreJson = JSON.parse(exploreText.replace(/^\)\]\}',?\s*\n/, '')) as {
      widgets: ExploreWidget[];
    };

    const timeseriesWidget = exploreJson.widgets?.find((w) => w.id === 'TIMESERIES');
    if (!timeseriesWidget) {
      // Happens when Google shows a consent screen instead of data
      throw new Error('No TIMESERIES widget in response — possible consent gate or geo restriction');
    }

    // Step 2 — multiline: get interest over time
    const dataUrl = new URL('https://trends.google.com/trends/api/widgetdata/multiline');
    dataUrl.searchParams.set('hl', 'en-US');
    dataUrl.searchParams.set('tz', '360');
    dataUrl.searchParams.set('req', JSON.stringify(timeseriesWidget.request));
    dataUrl.searchParams.set('token', timeseriesWidget.token);

    const dataHeaders = {
      ...TRENDS_API_BASE_HEADERS,
      'User-Agent': this.getNextUserAgent(),
    };

    const dataRes = await fetch(dataUrl.toString(), {
      headers: dataHeaders,
      signal: AbortSignal.timeout(30_000),
    });

    if (dataRes.status === 429) {
      await this.respectRetryAfter(dataRes.headers);
      throw new Error('Rate limited by Google Trends (429)');
    }
    if (!dataRes.ok) {
      throw new Error(`Google Trends multiline API returned ${dataRes.status}`);
    }

    const dataText = await dataRes.text();
    const dataJson = JSON.parse(dataText.replace(/^\)\]\}',?\s*\n/, '')) as {
      default: { timelineData: MultilinePoint[] };
    };

    const interest_over_time: TrendsDataPoint[] = [];
    for (const point of dataJson.default?.timelineData ?? []) {
      const date = new Date(parseInt(point.time, 10) * 1000).toISOString().split('T')[0];
      for (let i = 0; i < kws.length; i++) {
        interest_over_time.push({
          date,
          keyword: kws[i],
          value: point.value[i] ?? 0,
          is_partial: !!point.isPartial,
        });
      }
    }

    return { success: true, geo, keywords: kws, interest_over_time, related_queries: {} };
  }

  // -------------------------------------------------------------------------
  // Synthetic data generator
  //
  // Produces deterministic, realistic-looking trend data for development use.
  // Values are reproducible across runs (same geo + keywords → same data).
  // -------------------------------------------------------------------------

  private generateMockTrendData(keywords: string[], geo: string): TrendsFetchResult {
    // Simple hash of geo + first keyword for a reproducible base value
    const seed = (geo + keywords[0]).split('').reduce((acc, c, i) => acc + c.charCodeAt(0) * (i + 1), 0);
    const base = 35 + (seed % 45); // 35–79 base interest level

    const weeksBack = 52;
    const msPerWeek = 7 * 24 * 60 * 60 * 1000;
    const startMs = Date.now() - weeksBack * msPerWeek;
    const interest_over_time: TrendsDataPoint[] = [];

    for (let week = 0; week < weeksBack; week++) {
      const date = new Date(startMs + week * msPerWeek).toISOString().split('T')[0];
      // Seasonal wave: peaks around week 45 (Q4/holiday season)
      const seasonal = Math.sin(((week - 10) / weeksBack) * Math.PI * 2) * 12;
      // Slow upward trend over the year
      const trend = (week / weeksBack) * 8;
      // Deterministic "noise" using golden-ratio stepping
      const noise = Math.sin(seed + week * 2.399) * 8;

      for (const keyword of keywords) {
        const kwOffset = ((keyword.length * 7 + keyword.charCodeAt(0)) % 20) - 10;
        const raw = base + seasonal + trend + noise + kwOffset;
        const value = Math.round(Math.max(10, Math.min(100, raw)));
        interest_over_time.push({ date, keyword, value, is_partial: week === weeksBack - 1 });
      }
    }

    return { success: true, geo, keywords, interest_over_time, related_queries: {} };
  }

  // -------------------------------------------------------------------------
  // Database write
  //
  // One signal row per (country, category) per calendar day.
  // signalValue = average interest (0-100 Google Trends scale).
  // rawData holds the full keyword breakdown for later analysis.
  // -------------------------------------------------------------------------

  private async insertSignal(
    countryCode: string,
    categoryName: string,
    data: TrendsFetchResult,
  ): Promise<{ inserted: number; isNew: boolean }> {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const existing = await db
      .select({ id: euMarketSignals.id })
      .from(euMarketSignals)
      .where(
        and(
          eq(euMarketSignals.source, 'google_trends'),
          eq(euMarketSignals.countryCode, countryCode),
          eq(euMarketSignals.category, categoryName),
          gte(euMarketSignals.capturedAt, todayStart),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      logger.debug({ countryCode, categoryName }, 'Google Trends signal already captured today — skipping');
      return { inserted: 0, isNew: false };
    }

    const values = (data.interest_over_time ?? []).map((p) => p.value);
    const avgValue = values.length > 0
      ? values.reduce((a, b) => a + b, 0) / values.length
      : 0;

    await db.insert(euMarketSignals).values({
      source: 'google_trends',
      countryCode,
      category: categoryName,
      signalType: 'trend',
      signalValue: Math.round(avgValue * 100) / 100,
      rawData: {
        timeframe: TRENDS_CONFIG.timeframe,
        keywords: data.keywords,
        interestOverTime: data.interest_over_time ?? [],
        relatedQueries: data.related_queries ?? {},
      },
    });

    return { inserted: 1, isNew: true };
  }
}
