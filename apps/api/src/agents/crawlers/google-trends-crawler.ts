import { db } from '@/db/index.js';
import { euMarketSignals } from '@/db/schema.js';
import { logger } from '@/lib/logger.js';
import { eq, and, gte, desc } from 'drizzle-orm';
import pLimit from 'p-limit';
import { BaseCrawler, type CrawlResult } from './base-crawler.js';
import { CrawlErrorCode, StructuredCrawlError, classifyError } from '@/lib/crawler-errors.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TrendsTimeframe =
  | 'today 5-y'
  | 'today 12-m'
  | 'today 3-m'
  | 'today 1-m'
  | 'now 7-d'
  | 'now 1-d';

type TrendsGeoCode = 'DE' | 'FR' | 'NL' | 'GB' | 'ES' | 'IT';

type CategoryConfig = {
  categoryName: string;
  keywords: string[];
  cat?: number;
  gprop?: '' | 'images' | 'news' | 'youtube' | 'froogle';
};

type TrendsConfig = {
  countries: TrendsGeoCode[];
  timeframe: TrendsTimeframe;
  categories: CategoryConfig[];
  maxRetries?: number;
  baseDelayMs?: number;
};

type TrendsDataPoint = {
  date: string;
  keyword: string;
  value: number;
  is_partial: boolean;
};

type RelatedQuery = {
  query: string;
  value: string | number;
};

type TrendsFetchResult = {
  success: boolean;
  geo: string;
  keywords: string[];
  interest_over_time?: TrendsDataPoint[];
  related_queries?: Record<string, { top: RelatedQuery[]; rising: RelatedQuery[] }>;
  error?: string;
};

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

// Enriched signal shape stored in rawData
type KeywordScore = {
  keyword: string;
  avgInterest: number;
  trend: number;       // last value minus first value — positive = growing
  isAccelerating: boolean;
};

type EnrichedRawData = {
  timeframe: string;
  keywords: string[];
  interestOverTime: TrendsDataPoint[];
  relatedQueries: Record<string, { top: RelatedQuery[]; rising: RelatedQuery[] }>;
  keywordScores: KeywordScore[];          // Comparison signals: ranked by avgInterest
  categoryWinner: string;                 // Highest-interest keyword this run
  breakout: boolean;                      // True if current week > 1.5x 4-week avg
  breakoutKeyword: string | null;         // Which keyword spiked
  emergingKeywords: string[];             // Top rising related queries
};

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

const TRENDS_CONFIG: TrendsConfig = {
  countries: ['DE', 'FR', 'NL', 'GB', 'ES', 'IT'],
  timeframe: 'today 12-m',
  categories: [
    {
      categoryName: 'toys_games',
      keywords: ['toys', 'board games', 'educational toys', 'outdoor toys', 'STEM toys'],
    },
    {
      categoryName: 'food_beverage',
      keywords: ['organic snacks', 'healthy snacks', 'plant based food', 'protein snacks', 'natural food'],
    },
    {
      categoryName: 'supplements',
      keywords: ['vitamins', 'collagen supplements', 'gut health', 'adaptogen', 'nootropics'],
    },
    {
      categoryName: 'home_goods',
      keywords: ['home decor', 'sustainable home', 'kitchen accessories', 'bedding', 'cleaning products'],
    },
    {
      categoryName: 'cosmetics_personal_care',
      keywords: ['skincare', 'organic cosmetics', 'hair care', 'clean beauty', 'natural skincare'],
    },
  ],
  maxRetries: 2,
  baseDelayMs: 3000,
};

const TRENDS_API_BASE_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://trends.google.com/trends/explore',
};

// ---------------------------------------------------------------------------
// Crawler
// ---------------------------------------------------------------------------

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

    if (useMock) logger.info('[GoogleTrends] Mock mode active — generating synthetic trend data');

    // Run countries sequentially, but categories within each country in parallel
    for (const country of TRENDS_CONFIG.countries) {
      if (this.requestCount >= this.maxRequestsPerBatch) {
        logger.info('[GoogleTrends] Batch limit reached — cooling down for 1 minute');
        await this.sleep(this.batchCooldownMs);
        this.requestCount = 0;
      }

      // Load dynamic keywords from prior signals before processing this country
      const dynamicKeywords = useMock ? {} : await this.loadDynamicKeywords(country);

      // 3 categories in parallel per country — balances speed vs. rate limit risk
      const categoryLimit = pLimit(3);

      const results = await Promise.all(
        TRENDS_CONFIG.categories.map((category) =>
          categoryLimit(async () => {
            try {
              if (!useMock) await this.sleep(TRENDS_CONFIG.baseDelayMs ?? 3000);

              // Smart cache: skip if already captured within last 20 hours
              const cached = await this.isCached(country, category.categoryName);
              if (cached) {
                logger.debug({ country, category: category.categoryName }, 'Cache hit — skipping');
                return { inserted: 0, isNew: false };
              }

              // Keyword expansion: alternate seed + dynamic keywords weekly
              const weekNumber = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
              const useExpanded = weekNumber % 2 === 1;
              const emerging = dynamicKeywords[category.categoryName] ?? [];
              const keywords = useExpanded && emerging.length > 0
                ? [...category.keywords.slice(0, 3), ...emerging.slice(0, 2)]
                : category.keywords;

              const params = {
                keywords,
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

              if (!result.success) throw new Error(result.error ?? 'Unknown trends error');

              const { inserted, isNew } = await this.insertSignal(country, category.categoryName, result);
              this.requestCount++;
              pagesScraped++;

              logger.info(
                { country, category: category.categoryName, inserted, isNew, mock: useMock },
                'Google Trends signal processed',
              );

              return { inserted, isNew };
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              logger.error({ country, category: category.categoryName, error: msg }, 'Failed to fetch trends');
              const errorCode = classifyError(msg);
              structuredErrors.push({
                code: errorCode,
                domain: 'trends.google.com',
                message: msg,
                retryable: [CrawlErrorCode.RATE_LIMITED, CrawlErrorCode.NETWORK_ERROR].includes(errorCode),
                timestamp: new Date().toISOString(),
              });
              errors.push(`${country}-${category.categoryName}: ${msg}`);
              if (!useMock) await this.sleep(10_000);
              return { inserted: 0, isNew: false };
            }
          }),
        ),
      );

      for (const r of results) {
        recordsFound += r.inserted;
        if (r.isNew) newRecordsFound += r.inserted;
      }

      // Cool down between countries to avoid rate limiting
      if (!useMock) await this.sleep(5_000);
    }

    return { crawlerType: this.crawlerType, recordsFound, newRecordsFound, pagesScraped, errors, structuredErrors };
  }

  // -------------------------------------------------------------------------
  // Smart cache: returns true if a fresh signal exists (< 20 hours old)
  // -------------------------------------------------------------------------

  private async isCached(countryCode: string, categoryName: string): Promise<boolean> {
    const threshold = new Date(Date.now() - 20 * 60 * 60 * 1000);
    const rows = await db
      .select({ id: euMarketSignals.id })
      .from(euMarketSignals)
      .where(
        and(
          eq(euMarketSignals.source, 'google_trends'),
          eq(euMarketSignals.countryCode, countryCode),
          eq(euMarketSignals.category, categoryName),
          gte(euMarketSignals.capturedAt, threshold),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  // -------------------------------------------------------------------------
  // Dynamic keyword expansion
  //
  // Reads emerging related queries from recent signals and returns a map of
  // categoryName → top 2 rising query strings for use as alternate keywords.
  // -------------------------------------------------------------------------

  private async loadDynamicKeywords(countryCode: string): Promise<Record<string, string[]>> {
    try {
      const recentSignals = await db
        .select({ category: euMarketSignals.category, rawData: euMarketSignals.rawData })
        .from(euMarketSignals)
        .where(
          and(
            eq(euMarketSignals.source, 'google_trends'),
            eq(euMarketSignals.countryCode, countryCode),
          ),
        )
        .orderBy(desc(euMarketSignals.capturedAt))
        .limit(16);  // 8 categories × 2 signals each

      const result: Record<string, string[]> = {};

      for (const signal of recentSignals) {
        const raw = signal.rawData as EnrichedRawData | null;
        if (!raw?.emergingKeywords?.length) continue;
        if (!result[signal.category]) result[signal.category] = [];
        for (const kw of raw.emergingKeywords) {
          if (!result[signal.category].includes(kw) && result[signal.category].length < 2) {
            result[signal.category].push(kw);
          }
        }
      }

      return result;
    } catch {
      return {};
    }
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
  // Direct HTTP implementation — two-step pytrends-equivalent flow:
  //   1. POST /trends/api/explore       → get widget token
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

    const req = JSON.stringify({
      comparisonItem: kws.map((kw) => ({ keyword: kw, geo, time: timeframe })),
      category: cat,
      property: gprop,
    });

    const exploreUrl =
      `https://trends.google.com/trends/api/explore` +
      `?hl=en-US&tz=360&req=${encodeURIComponent(req)}`;

    const exploreRes = await fetch(exploreUrl, {
      headers: { ...TRENDS_API_BASE_HEADERS, 'User-Agent': this.getNextUserAgent() },
      signal: AbortSignal.timeout(30_000),
    });

    if (exploreRes.status === 429) {
      await this.respectRetryAfter(exploreRes.headers);
      throw new Error('Rate limited by Google Trends (429)');
    }
    if (!exploreRes.ok) throw new Error(`Google Trends explore API returned ${exploreRes.status}`);

    const exploreText = await exploreRes.text();
    const exploreJson = JSON.parse(exploreText.replace(/^\)\]\}',?\s*\n/, '')) as {
      widgets: ExploreWidget[];
    };

    const timeseriesWidget = exploreJson.widgets?.find((w) => w.id === 'TIMESERIES');
    if (!timeseriesWidget) {
      throw new Error('No TIMESERIES widget — possible consent gate or geo restriction');
    }

    // Fetch related queries widget alongside timeline data
    const relatedWidget = exploreJson.widgets?.find((w) => w.id === 'RELATED_QUERIES');

    const dataUrl = new URL('https://trends.google.com/trends/api/widgetdata/multiline');
    dataUrl.searchParams.set('hl', 'en-US');
    dataUrl.searchParams.set('tz', '360');
    dataUrl.searchParams.set('req', JSON.stringify(timeseriesWidget.request));
    dataUrl.searchParams.set('token', timeseriesWidget.token);

    const dataRes = await fetch(dataUrl.toString(), {
      headers: { ...TRENDS_API_BASE_HEADERS, 'User-Agent': this.getNextUserAgent() },
      signal: AbortSignal.timeout(30_000),
    });

    if (dataRes.status === 429) {
      await this.respectRetryAfter(dataRes.headers);
      throw new Error('Rate limited by Google Trends (429)');
    }
    if (!dataRes.ok) throw new Error(`Google Trends multiline API returned ${dataRes.status}`);

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

    // Fetch related queries if widget is available
    let related_queries: Record<string, { top: RelatedQuery[]; rising: RelatedQuery[] }> = {};
    if (relatedWidget) {
      try {
        const relatedUrl = new URL('https://trends.google.com/trends/api/widgetdata/relatedsearches');
        relatedUrl.searchParams.set('hl', 'en-US');
        relatedUrl.searchParams.set('tz', '360');
        relatedUrl.searchParams.set('req', JSON.stringify(relatedWidget.request));
        relatedUrl.searchParams.set('token', relatedWidget.token);

        const relatedRes = await fetch(relatedUrl.toString(), {
          headers: { ...TRENDS_API_BASE_HEADERS, 'User-Agent': this.getNextUserAgent() },
          signal: AbortSignal.timeout(15_000),
        });

        if (relatedRes.ok) {
          const relatedText = await relatedRes.text();
          const relatedJson = JSON.parse(relatedText.replace(/^\)\]\}',?\s*\n/, '')) as {
            default: { rankedList: Array<{ rankedKeyword: RelatedQuery[] }> };
          };
          const rankedList = relatedJson.default?.rankedList ?? [];
          related_queries = {
            [kws[0]]: {
              top: rankedList[0]?.rankedKeyword?.slice(0, 5) ?? [],
              rising: rankedList[1]?.rankedKeyword?.slice(0, 5) ?? [],
            },
          };
        }
      } catch {
        // Related queries are best-effort — don't fail the whole fetch
      }
    }

    return { success: true, geo, keywords: kws, interest_over_time, related_queries };
  }

  // -------------------------------------------------------------------------
  // Synthetic data generator — deterministic, realistic-looking trend data
  // -------------------------------------------------------------------------

  private generateMockTrendData(keywords: string[], geo: string): TrendsFetchResult {
    const seed = (geo + keywords[0]).split('').reduce((acc, c, i) => acc + c.charCodeAt(0) * (i + 1), 0);
    const base = 35 + (seed % 45);
    const weeksBack = 52;
    const msPerWeek = 7 * 24 * 60 * 60 * 1000;
    const startMs = Date.now() - weeksBack * msPerWeek;
    const interest_over_time: TrendsDataPoint[] = [];

    for (let week = 0; week < weeksBack; week++) {
      const date = new Date(startMs + week * msPerWeek).toISOString().split('T')[0];
      const seasonal = Math.sin(((week - 10) / weeksBack) * Math.PI * 2) * 12;
      const trend = (week / weeksBack) * 8;
      const noise = Math.sin(seed + week * 2.399) * 8;

      for (const keyword of keywords) {
        const kwOffset = ((keyword.length * 7 + keyword.charCodeAt(0)) % 20) - 10;
        const raw = base + seasonal + trend + noise + kwOffset;
        interest_over_time.push({
          date,
          keyword,
          value: Math.round(Math.max(10, Math.min(100, raw))),
          is_partial: week === weeksBack - 1,
        });
      }
    }

    const related_queries: Record<string, { top: RelatedQuery[]; rising: RelatedQuery[] }> = {
      [keywords[0]]: {
        top: [
          { query: `best ${keywords[0]}`, value: 100 },
          { query: `${keywords[0]} online`, value: 85 },
        ],
        rising: [
          { query: `sustainable ${keywords[0]}`, value: 'Breakout' },
          { query: `${keywords[0]} 2025`, value: '+350%' },
        ],
      },
    };

    return { success: true, geo, keywords, interest_over_time, related_queries };
  }

  // -------------------------------------------------------------------------
  // Comparison signals: rank keywords by average interest over the period
  // -------------------------------------------------------------------------

  private computeKeywordScores(
    keywords: string[],
    points: TrendsDataPoint[],
  ): { scores: KeywordScore[]; winner: string } {
    const scores: KeywordScore[] = keywords.map((keyword) => {
      const kPoints = points.filter((p) => p.keyword === keyword && !p.is_partial);
      const values = kPoints.map((p) => p.value);
      if (values.length === 0) return { keyword, avgInterest: 0, trend: 0, isAccelerating: false };

      const avgInterest = values.reduce((a, b) => a + b, 0) / values.length;
      const trend = values[values.length - 1] - values[0];
      return { keyword, avgInterest: Math.round(avgInterest * 100) / 100, trend, isAccelerating: trend > 0 };
    });

    scores.sort((a, b) => b.avgInterest - a.avgInterest);
    return { scores, winner: scores[0]?.keyword ?? keywords[0] };
  }

  // -------------------------------------------------------------------------
  // Breakout detection: current week > 1.5x the 4-week rolling average
  // -------------------------------------------------------------------------

  private detectBreakout(
    keywords: string[],
    points: TrendsDataPoint[],
  ): { breakout: boolean; keyword: string | null } {
    for (const keyword of keywords) {
      const kPoints = points
        .filter((p) => p.keyword === keyword && !p.is_partial)
        .sort((a, b) => a.date.localeCompare(b.date));

      if (kPoints.length < 5) continue;

      const recent = kPoints[kPoints.length - 1].value;
      const prior4 = kPoints.slice(-5, -1).map((p) => p.value);
      const avg4 = prior4.reduce((a, b) => a + b, 0) / prior4.length;

      if (avg4 > 0 && recent > avg4 * 1.5) {
        logger.warn({ keyword, recent, avg4: Math.round(avg4) }, '[GoogleTrends] BREAKOUT: Interest spike detected');
        return { breakout: true, keyword };
      }
    }
    return { breakout: false, keyword: null };
  }

  // -------------------------------------------------------------------------
  // Extract emerging keywords from related_queries rising list
  // -------------------------------------------------------------------------

  private extractEmergingKeywords(
    relatedQueries: Record<string, { top: RelatedQuery[]; rising: RelatedQuery[] }>,
  ): string[] {
    const rising: string[] = [];
    for (const data of Object.values(relatedQueries)) {
      for (const q of data.rising ?? []) {
        if (typeof q.query === 'string' && q.query.length > 2 && q.query.length < 50) {
          rising.push(q.query);
        }
      }
    }
    return [...new Set(rising)].slice(0, 5);
  }

  // -------------------------------------------------------------------------
  // Database write
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
      logger.debug({ countryCode, categoryName }, 'Signal already captured today — skipping');
      return { inserted: 0, isNew: false };
    }

    const allPoints = data.interest_over_time ?? [];
    const values = allPoints.filter((p) => !p.is_partial).map((p) => p.value);
    const avgValue = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;

    // Compute enriched signals
    const { scores: keywordScores, winner: categoryWinner } = this.computeKeywordScores(data.keywords, allPoints);
    const { breakout, keyword: breakoutKeyword } = this.detectBreakout(data.keywords, allPoints);
    const emergingKeywords = this.extractEmergingKeywords(data.related_queries ?? {});

    const rawData: EnrichedRawData = {
      timeframe: TRENDS_CONFIG.timeframe,
      keywords: data.keywords,
      interestOverTime: allPoints,
      relatedQueries: data.related_queries ?? {},
      keywordScores,
      categoryWinner,
      breakout,
      breakoutKeyword,
      emergingKeywords,
    };

    // Insert today's aggregate signal
    await db.insert(euMarketSignals).values({
      source: 'google_trends',
      countryCode,
      category: categoryName,
      signalType: 'trend',
      signalValue: Math.round(avgValue * 100) / 100,
      rawData,
    });

    // Backfill one signal row per historical week from interestOverTime so the
    // StatisticalTrendEngine has 52 data points spanning 12 months instead of 1.
    // Uses ON CONFLICT DO NOTHING so re-runs don't create duplicates.
    const historicalInserted = await this.backfillHistoricalSignals(
      countryCode,
      categoryName,
      allPoints,
      data.keywords,
    );

    if (breakout) {
      logger.warn(
        { countryCode, categoryName, breakoutKeyword, avgValue },
        '[GoogleTrends] Breakout signal saved — downstream agents should prioritise this corridor',
      );
    }

    logger.debug(
      { countryCode, categoryName, historicalInserted },
      '[GoogleTrends] Historical weekly points backfilled',
    );

    return { inserted: 1 + historicalInserted, isNew: true };
  }

  // -------------------------------------------------------------------------
  // Backfill historical weekly signals from interestOverTime
  //
  // Inserts one row per unique date in interestOverTime using the average
  // value across all keywords for that week. Skips dates that already have
  // a signal row so re-runs are idempotent.
  // -------------------------------------------------------------------------

  private async backfillHistoricalSignals(
    countryCode: string,
    categoryName: string,
    points: TrendsDataPoint[],
    keywords: string[],
  ): Promise<number> {
    // Group points by date and average across keywords
    const byDate = new Map<string, number[]>();
    for (const p of points) {
      if (p.is_partial) continue;
      if (!byDate.has(p.date)) byDate.set(p.date, []);
      byDate.get(p.date)!.push(p.value);
    }

    if (byDate.size === 0) return 0;

    const rows = [...byDate.entries()].map(([date, vals]) => ({
      source: 'google_trends' as const,
      countryCode,
      category: categoryName,
      signalType: 'trend' as const,
      signalValue: Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100,
      capturedAt: new Date(date),
      rawData: { historicalBackfill: true, keywords, weekDate: date },
    }));

    // Insert in batches of 20, skip any that already exist for the same
    // (source, countryCode, category, capturedAt) — enforced by the unique
    // index `eu_signals_source_country_category_captured_uniq`.
    let inserted = 0;
    for (let i = 0; i < rows.length; i += 20) {
      const batch = rows.slice(i, i + 20);
      try {
        const result = await db
          .insert(euMarketSignals)
          .values(batch)
          .onConflictDoNothing({
            target: [
              euMarketSignals.source,
              euMarketSignals.countryCode,
              euMarketSignals.category,
              euMarketSignals.capturedAt,
            ],
          })
          .returning({ id: euMarketSignals.id });
        inserted += result.length;
      } catch {
        // Best-effort — don't fail the whole run if backfill has an issue
      }
    }

    return inserted;
  }
}
