import Fastify from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import { logger } from '../lib/logger.js';
import { db } from '../db/index.js';
import { brands, crawlJobs, euMarketSignals, tradeShows, tradeShowExhibitors, tradeShowPlaybooks, trends, gapScores, retailerInsights, tradeFlowIntelligence, tradeFlowAnalytics, niRoutingSignals, opportunityCorrelations, opportunityScores, humanReviewItems, insights, leads, leadCampaigns, leadPipeline } from '../db/schema.js';
import { desc, asc, eq, and, gte, lte, isNull, isNotNull, sql, inArray, type SQL } from 'drizzle-orm';
import type { CrawlerScheduler } from '../agents/crawlers/scheduler.js';

// ---------------------------------------------------------------------------
// Request / response schemas
// ---------------------------------------------------------------------------

const BrandsQuerySchema = z.object({
  limit:  z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  euPresence: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

const SignalsQuerySchema = z.object({
  countryCode: z.string().length(2).toUpperCase().optional(),
  category:    z.string().min(1).optional(),
  source:      z.enum(['google_trends', 'amazon_eu', 'social', 'retailer', 'trade_data']).optional(),
  /** Only return signals captured on or after this ISO date (e.g. 2026-03-01) */
  since:       z.string().datetime({ offset: true }).optional(),
  limit:       z.coerce.number().int().min(1).max(200).default(50),
});

const TrendsQuerySchema = z.object({
  countryCode:    z.string().length(2).toUpperCase().optional(),
  category:       z.string().min(1).optional(),
  minGrowthRate:  z.coerce.number().min(-1).max(100).optional(),
  tier:           z.enum(['breakthrough', 'accelerating', 'sustained', 'mature', 'disrupted', 'watch']).optional(),
  status:         z.enum(['detected', 'published']).optional(),
  limit:          z.coerce.number().int().min(1).max(100).default(50),
});

const GapScoresQuerySchema = z.object({
  countryCode:   z.string().length(2).toUpperCase().optional(),
  category:      z.string().min(1).optional(),
  minGapScore:   z.coerce.number().min(0).max(100).optional(),
  limit:         z.coerce.number().int().min(1).max(100).default(50),
});

const RetailerInsightsQuerySchema = z.object({
  countryCode:  z.string().length(2).toUpperCase().optional(),
  category:     z.string().min(1).optional(),
  patternType:  z.enum(['expansion', 'rotation', 'us_brand_entry']).optional(),
  limit:        z.coerce.number().int().min(1).max(100).default(50),
});

const CrawlJobsQuerySchema = z.object({
  crawlerType: z.string().optional(),
  limit:       z.coerce.number().int().min(1).max(100).default(20),
});

const TradeFlowsQuerySchema = z.object({
  flowType:  z.enum(['us_to_eu', 'eu_to_us', 'us_to_uk', 'uk_to_eu']).optional(),
  category:  z.string().min(1).optional(),
  country:   z.string().min(2).toUpperCase().optional(),
  year:      z.coerce.number().int().min(2019).max(2024).optional(),
  limit:     z.coerce.number().int().min(1).max(500).default(100),
});

const TradeAnalyticsQuerySchema = z.object({
  flowType:        z.enum(['us_to_eu', 'eu_to_us', 'us_to_uk', 'uk_to_eu']).optional(),
  category:        z.string().min(1).optional(),
  country:         z.string().min(2).toUpperCase().optional(),
  year:            z.coerce.number().int().min(2019).max(2025).optional(),
  isAccelerating:  z.enum(['true', 'false']).transform(v => v === 'true').optional(),
  minAcceleration: z.coerce.number().min(-100).max(500).optional(),
  limit:           z.coerce.number().int().min(1).max(500).default(100),
});

const NiRoutingSignalsQuerySchema = z.object({
  signalType:   z.enum(['irish_sea_routing', 'uk_reexport_arb', 'air_freight_suitable', 'distributor_gap']).optional(),
  nclCategory:  z.string().min(1).optional(),
  euCountry:    z.string().min(2).toUpperCase().optional(),
  minStrength:  z.coerce.number().min(0).max(1).optional(),
  limit:        z.coerce.number().int().min(1).max(200).default(50),
});

const HumanReviewQuerySchema = z.object({
  type:   z.string().min(1).optional(),
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
  limit:  z.coerce.number().int().min(1).max(100).default(50),
});

const HumanReviewPatchSchema = z.object({
  status:     z.enum(['approved', 'rejected']),
  reviewedBy: z.string().min(1).optional(),
  notes:      z.string().optional(),
});

const LeadPatchSchema = z.object({
  status:     z.enum(['new', 'reviewed', 'approved', 'contacted', 'replied', 'qualified', 'won', 'lost', 'invalid']),
  assignedTo: z.string().optional(),
  notes:      z.string().optional(),
});

const OpportunityScoresQuerySchema = z.object({
  countryCode:   z.string().length(2).toUpperCase().optional(),
  category:      z.string().min(1).optional(),
  minComposite:  z.coerce.number().min(0).max(100).optional(),
  limit:         z.coerce.number().int().min(1).max(200).default(50),
});

const CorrelationsQuerySchema = z.object({
  countryCode:  z.string().length(2).toUpperCase().optional(),
  category:     z.string().min(1).optional(),
  tier:         z.enum(['breakthrough', 'accelerating', 'sustained', 'mature', 'disrupted', 'watch']).optional(),
  minScore:     z.coerce.number().min(0).max(100).optional(),
  limit:        z.coerce.number().int().min(1).max(100).default(50),
});

const TradeShowsQuerySchema = z.object({
  /** When true (default), only return shows with startDate >= today */
  upcoming:       z.enum(['true', 'false']).transform((v) => v === 'true').default('true'),
  /** Include up to N exhibitors per show inline */
  withExhibitors: z.enum(['true', 'false']).transform((v) => v === 'true').default('false'),
  limit:          z.coerce.number().int().min(1).max(50).default(20),
});

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export type ServerOptions = {
  /** Injected scheduler for crawler trigger endpoints. */
  scheduler?: CrawlerScheduler;
};

export async function buildServer({ scheduler }: ServerOptions = {}) {
  const app = Fastify({ logger: false });

  // -------------------------------------------------------------------------
  // Raw-body capture for webhook signature verification.
  //
  // svix verifies HMAC over the exact request bytes; once Fastify's default
  // JSON parser runs, JSON.stringify(body) does not always reproduce them.
  // We register a JSON parser that stashes the raw string on the request and
  // still parses to an object for the route handler.
  // -------------------------------------------------------------------------

  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as { rawBody?: string }).rawBody = body as string;
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // -------------------------------------------------------------------------
  // CORS
  // -------------------------------------------------------------------------

  await app.register(cors, {
    origin: [
      process.env.DASHBOARD_URL ?? 'http://localhost:3000',
      // Allow local development from any port if CORS_ALLOW_ALL is set
      ...(process.env.CORS_ALLOW_ALL === 'true' ? ['*'] : []),
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
  });

  // -------------------------------------------------------------------------
  // Request logging
  // -------------------------------------------------------------------------

  app.addHook('onResponse', (request, reply, done) => {
    logger.info(
      {
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        responseTimeMs: Math.round(reply.elapsedTime),
      },
      'Request',
    );
    done();
  });

  // -------------------------------------------------------------------------
  // API key authentication  (skip for /health)
  // -------------------------------------------------------------------------

  app.addHook('onRequest', async (request, reply) => {
    // Exempt: health check and external webhooks (carry their own svix HMAC auth)
    if (request.url === '/health') return;
    if (request.url.startsWith('/api/webhooks/')) return;

    const apiKey = request.headers['x-api-key'];
    if (!apiKey || apiKey !== process.env.API_SECRET_KEY) {
      return reply.code(401).send({
        error: 'Unauthorized',
        code: 'INVALID_API_KEY',
      });
    }
  });

  // -------------------------------------------------------------------------
  // Global error handler
  // -------------------------------------------------------------------------

  app.setErrorHandler((error: { statusCode?: number; message: string; code?: string }, request, reply) => {
    logger.error({ err: error, method: request.method, url: request.url }, 'Unhandled error');
    const status = error.statusCode ?? 500;
    reply.code(status).send({
      error: status >= 500 ? 'Internal Server Error' : error.message,
      code: error.code ?? 'INTERNAL_ERROR',
    });
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: 'Not Found', code: 'NOT_FOUND' });
  });

  // =========================================================================
  // Routes
  // =========================================================================

  // -------------------------------------------------------------------------
  // Health check — unauthenticated, used by Railway / load balancers
  // -------------------------------------------------------------------------

  app.get('/health', async (_request, reply) => {
    // Verify DB connectivity on every health check so Railway / load balancers
    // can detect a broken database connection and restart the container.
    try {
      await db.execute(sql`SELECT 1`);
    } catch {
      return reply.code(503).send({
        status: 'degraded',
        db: 'unreachable',
        timestamp: new Date().toISOString(),
        service: 'ncl-mie-api',
      });
    }
    return {
      status: 'ok',
      db: 'connected',
      timestamp: new Date().toISOString(),
      service: 'ncl-mie-api',
    };
  });

  // -------------------------------------------------------------------------
  // Crawlers — list registered types + recent job history
  // -------------------------------------------------------------------------

  app.get('/api/crawlers', async (_request, reply) => {
    const jobs = await db
      .select({
        id: crawlJobs.id,
        crawlerType: crawlJobs.crawlerType,
        status: crawlJobs.status,
        startedAt: crawlJobs.startedAt,
        completedAt: crawlJobs.completedAt,
        recordsFound: crawlJobs.recordsFound,
        errorLog: crawlJobs.errorLog,
        pagesCrawled: crawlJobs.pagesCrawled,
        durationMs: crawlJobs.durationMs,
        lastFreshAt: crawlJobs.lastFreshAt,
        errorDetails: crawlJobs.errorDetails,
      })
      .from(crawlJobs)
      .orderBy(desc(crawlJobs.startedAt))
      .limit(20);

    return reply.send({
      registered: scheduler?.registeredCrawlers() ?? [],
      recentJobs: jobs,
    });
  });

  // -------------------------------------------------------------------------
  // Crawlers — manual trigger
  // -------------------------------------------------------------------------

  app.post<{ Params: { type: string } }>('/api/crawlers/:type/trigger', async (request, reply) => {
    const { type } = request.params;

    if (!scheduler) {
      return reply.code(503).send({
        error: 'Scheduler not available',
        code: 'NO_SCHEDULER',
      });
    }

    try {
      await scheduler.trigger(type);
      return reply.send({ queued: true, crawlerType: type });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Queue infrastructure errors (e.g. Redis < 5) — fall back to running the
      // crawler directly in the background so the button still works without Redis.
      if (msg.includes('Redis') || msg.includes('ECONNREFUSED') || msg.includes('NOAUTH')) {
        try {
          scheduler.runDirect(type);
          return reply.send({ queued: false, running: true, crawlerType: type, note: 'Running directly — Redis unavailable' });
        } catch (directErr) {
          const directMsg = directErr instanceof Error ? directErr.message : String(directErr);
          return reply.code(400).send({ error: directMsg, code: 'TRIGGER_FAILED' });
        }
      }
      // Unknown crawler type or other caller errors → 400
      return reply.code(400).send({ error: msg, code: 'TRIGGER_FAILED' });
    }
  });

  // -------------------------------------------------------------------------
  // Crawl jobs — paginated history
  // -------------------------------------------------------------------------

  app.get('/api/crawl-jobs', async (request, reply) => {
    const parsed = CrawlJobsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid query parameters',
        code: 'VALIDATION_ERROR',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { crawlerType, limit } = parsed.data;

    const rows = await db
      .select({
        id: crawlJobs.id,
        crawlerType: crawlJobs.crawlerType,
        status: crawlJobs.status,
        startedAt: crawlJobs.startedAt,
        completedAt: crawlJobs.completedAt,
        recordsFound: crawlJobs.recordsFound,
        errorLog: crawlJobs.errorLog,
        pagesCrawled: crawlJobs.pagesCrawled,
        durationMs: crawlJobs.durationMs,
        lastFreshAt: crawlJobs.lastFreshAt,
        errorDetails: crawlJobs.errorDetails,
      })
      .from(crawlJobs)
      .where(crawlerType ? eq(crawlJobs.crawlerType, crawlerType) : undefined)
      .orderBy(desc(crawlJobs.startedAt))
      .limit(limit);

    return reply.send({ jobs: rows });
  });

  // -------------------------------------------------------------------------
  // Brands — browse seeded brands
  // -------------------------------------------------------------------------

  app.get('/api/brands', async (request, reply) => {
    const parsed = BrandsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid query parameters',
        code: 'VALIDATION_ERROR',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { limit, offset, euPresence } = parsed.data;

    const rows = await db
      .select()
      .from(brands)
      .where(euPresence !== undefined ? eq(brands.euPresence, euPresence) : undefined)
      .orderBy(desc(brands.createdAt))
      .limit(limit)
      .offset(offset);

    return reply.send({ brands: rows, limit, offset });
  });

  // -------------------------------------------------------------------------
  // Brands — detail view with scores, lead, and recent signals
  // -------------------------------------------------------------------------

  app.get<{ Params: { id: string } }>('/api/brands/:id', async (request, reply) => {
    const { id } = request.params;

    const brandRow = await db
      .select()
      .from(brands)
      .where(eq(brands.id, id))
      .limit(1);

    if (brandRow.length === 0) {
      return reply.code(404).send({ error: 'Brand not found', code: 'NOT_FOUND' });
    }

    const brand = brandRow[0];
    const brandCategories = brand.categories ?? [];

    const [scores, leadRow, recentSignals] = await Promise.all([
      db
        .select()
        .from(opportunityScores)
        .where(eq(opportunityScores.brandId, id))
        .orderBy(desc(opportunityScores.compositeScore))
        .limit(20),

      db
        .select()
        .from(leads)
        .where(eq(leads.brandId, id))
        .limit(1),

      brandCategories.length > 0
        ? db
            .select({
              id: euMarketSignals.id,
              source: euMarketSignals.source,
              countryCode: euMarketSignals.countryCode,
              category: euMarketSignals.category,
              signalType: euMarketSignals.signalType,
              signalValue: euMarketSignals.signalValue,
              capturedAt: euMarketSignals.capturedAt,
            })
            .from(euMarketSignals)
            .where(inArray(euMarketSignals.category, brandCategories))
            .orderBy(desc(euMarketSignals.capturedAt))
            .limit(30)
        : Promise.resolve([]),
    ]);

    return reply.send({
      brand,
      scores,
      lead: leadRow[0] ?? null,
      recentSignals,
    });
  });

  // -------------------------------------------------------------------------
  // EU market signals — query by country / category / source
  // -------------------------------------------------------------------------

  app.get('/api/signals', async (request, reply) => {
    const parsed = SignalsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid query parameters',
        code: 'VALIDATION_ERROR',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { countryCode, category, source, since, limit } = parsed.data;

    const conditions: SQL[] = [
      countryCode ? eq(euMarketSignals.countryCode, countryCode)        : undefined,
      category    ? eq(euMarketSignals.category, category)              : undefined,
      source      ? eq(euMarketSignals.source, source)                  : undefined,
      since       ? gte(euMarketSignals.capturedAt, new Date(since))    : undefined,
    ].filter((c): c is SQL => c !== undefined);

    const rows = await db
      .select()
      .from(euMarketSignals)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(euMarketSignals.capturedAt))
      .limit(limit);

    return reply.send({ signals: rows, limit });
  });

  // -------------------------------------------------------------------------
  // Trade shows — upcoming shows with exhibitor counts (and optional detail)
  // -------------------------------------------------------------------------

  app.get('/api/trade-shows', async (request, reply) => {
    const parsed = TradeShowsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid query parameters',
        code: 'VALIDATION_ERROR',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { upcoming, withExhibitors, limit } = parsed.data;

    // Join with exhibitor count in a single query
    const rows = await db
      .select({
        id:             tradeShows.id,
        name:           tradeShows.name,
        location:       tradeShows.location,
        countryCode:    tradeShows.countryCode,
        startDate:      tradeShows.startDate,
        endDate:        tradeShows.endDate,
        categories:     tradeShows.categories,
        websiteUrl:     tradeShows.websiteUrl,
        exhibitorCount: sql<number>`cast(count(${tradeShowExhibitors.id}) as int)`,
      })
      .from(tradeShows)
      .leftJoin(tradeShowExhibitors, eq(tradeShowExhibitors.tradeShowId, tradeShows.id))
      .where(upcoming ? gte(tradeShows.startDate, new Date()) : undefined)
      .groupBy(tradeShows.id)
      .orderBy(asc(tradeShows.startDate))
      .limit(limit);

    // Optionally hydrate with exhibitor records (capped at 50 per show)
    if (withExhibitors) {
      const showIds = rows.map((r) => r.id);
      const exhibitorRows = showIds.length > 0
        ? await db
            .select()
            .from(tradeShowExhibitors)
            .where(
              showIds.length === 1
                ? eq(tradeShowExhibitors.tradeShowId, showIds[0])
                : sql`${tradeShowExhibitors.tradeShowId} = ANY(${sql.raw(`ARRAY[${showIds.map((id) => `'${id}'`).join(',')}]::uuid[]`)})`,
            )
            .limit(50 * showIds.length)
        : [];

      const exhibitorsByShow = exhibitorRows.reduce<Record<string, typeof exhibitorRows>>(
        (acc, ex) => {
          (acc[ex.tradeShowId] ??= []).push(ex);
          return acc;
        },
        {},
      );

      return reply.send({
        shows: rows.map((show) => ({
          ...show,
          exhibitors: (exhibitorsByShow[show.id] ?? []).slice(0, 50),
        })),
      });
    }

    return reply.send({ shows: rows });
  });

  // -------------------------------------------------------------------------
  // Trends — detected category/country growth trends
  // -------------------------------------------------------------------------

  app.get('/api/trends', async (request, reply) => {
    const parsed = TrendsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid query parameters',
        code: 'VALIDATION_ERROR',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { countryCode, category, minGrowthRate, tier, status, limit } = parsed.data;

    const conditions: SQL[] = [
      countryCode    ? eq(trends.countryCode, countryCode)               : undefined,
      category       ? eq(trends.category, category)                     : undefined,
      minGrowthRate  ? gte(trends.growthRate, minGrowthRate / 100)       : undefined,
      tier           ? eq(trends.opportunityTier, tier)                  : undefined,
      status         ? eq(trends.status, status)                         : undefined,
    ].filter((c): c is SQL => c !== undefined);

    const rows = await db
      .select()
      .from(trends)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(trends.growthRate))
      .limit(limit);

    return reply.send({ trends: rows, limit });
  });

  // -------------------------------------------------------------------------
  // Gap scores — demand-supply gap analysis per category/country
  // -------------------------------------------------------------------------

  app.get('/api/gaps', async (request, reply) => {
    const parsed = GapScoresQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid query parameters',
        code: 'VALIDATION_ERROR',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { countryCode, category, minGapScore, limit } = parsed.data;

    const conditions: SQL[] = [
      countryCode  ? eq(gapScores.countryCode, countryCode)         : undefined,
      category     ? eq(gapScores.category, category)               : undefined,
      minGapScore  ? gte(gapScores.gapScore, minGapScore)           : undefined,
    ].filter((c): c is SQL => c !== undefined);

    const rows = await db
      .select()
      .from(gapScores)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(gapScores.gapScore))
      .limit(limit);

    return reply.send({ gaps: rows, limit });
  });

  // -------------------------------------------------------------------------
  // Retailer insights — expansion, rotation and US brand entry patterns
  // -------------------------------------------------------------------------

  app.get('/api/retailer-insights', async (request, reply) => {
    const parsed = RetailerInsightsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid query parameters',
        code: 'VALIDATION_ERROR',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { countryCode, category, patternType, limit } = parsed.data;

    const conditions: SQL[] = [
      countryCode ? eq(retailerInsights.countryCode, countryCode)   : undefined,
      category    ? eq(retailerInsights.category, category)         : undefined,
      patternType ? eq(retailerInsights.patternType, patternType)   : undefined,
    ].filter((c): c is SQL => c !== undefined);

    const rows = await db
      .select()
      .from(retailerInsights)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(retailerInsights.detectedAt), desc(retailerInsights.confidence))
      .limit(limit);

    return reply.send({ insights: rows, limit });
  });

  // ── GET /api/trade-flows ───────────────────────────────────────────────────
  // Query trade flow intelligence rows with optional filters.
  // country matches partnerCountry for us_to_eu/eu_to_us/us_to_uk, and
  // partnerCountry for uk_to_eu (the EU destination).

  app.get('/api/trade-flows', async (request, reply) => {
    const parsed = TradeFlowsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid query parameters',
        code: 'VALIDATION_ERROR',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { flowType, category, country, year, limit } = parsed.data;

    const conditions: SQL[] = [
      flowType  ? eq(tradeFlowIntelligence.flowType, flowType)        : undefined,
      category  ? eq(tradeFlowIntelligence.nclCategory, category)     : undefined,
      country   ? eq(tradeFlowIntelligence.partnerCountry, country)   : undefined,
      year      ? eq(tradeFlowIntelligence.year, year)                : undefined,
    ].filter((c): c is SQL => c !== undefined);

    const rows = await db
      .select()
      .from(tradeFlowIntelligence)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(tradeFlowIntelligence.year), desc(tradeFlowIntelligence.tradeValueUsd))
      .limit(limit);

    return reply.send({ flows: rows, count: rows.length, limit });
  });

  // ── POST /api/agents/trade-flow/run ───────────────────────────────────────
  // Manually trigger the TradeFlowIntelligenceAgent (runs in background).
  // Returns immediately; the agent run is fire-and-forget (check agent_outputs).
  // Optional body: { forceRefresh: boolean } — bypasses the cache.

  app.post('/api/agents/trade-flow/run', async (request, reply) => {
    const { forceRefresh = false } = (request.body as { forceRefresh?: boolean }) ?? {};

    // Import lazily to avoid loading Playwright / heavy deps at startup
    const { TradeFlowIntelligenceAgent } = await import('../agents/signals/trade-flow-agent.js');
    const agent = new TradeFlowIntelligenceAgent();

    // Fire-and-forget — client gets an immediate 202
    agent.run(forceRefresh).catch((err: unknown) => {
      logger.error({ err }, '[server] TradeFlowIntelligenceAgent background run failed');
    });

    return reply.code(202).send({
      accepted: true,
      message: 'Trade flow intelligence run started',
      forceRefresh,
      note: 'Results will appear in /api/trade-flows and agent_outputs once complete (~1-2 min)',
    });
  });

  // ── GET /api/trade-analytics ───────────────────────────────────────────────
  // Query multi-layer analytics computed by TradeFlowAnalyticsEngine.
  // Supports filtering by flow, category, EU country, year, acceleration flag,
  // and a minimum acceleration score (for dashboard acceleration view).

  app.get('/api/trade-analytics', async (request, reply) => {
    const parsed = TradeAnalyticsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid query parameters',
        code: 'VALIDATION_ERROR',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { flowType, category, country, year, isAccelerating, minAcceleration, limit } = parsed.data;

    const conditions: SQL[] = [
      flowType       ? eq(tradeFlowAnalytics.flowType, flowType)           : undefined,
      category       ? eq(tradeFlowAnalytics.nclCategory, category)        : undefined,
      country        ? eq(tradeFlowAnalytics.partnerCountry, country)      : undefined,
      year           ? eq(tradeFlowAnalytics.asOfYear, year)               : undefined,
      isAccelerating !== undefined
        ? eq(tradeFlowAnalytics.isAccelerating, isAccelerating)            : undefined,
      minAcceleration !== undefined
        ? gte(tradeFlowAnalytics.accelerationScore, minAcceleration)       : undefined,
    ].filter((c): c is SQL => c !== undefined);

    const rows = await db
      .select()
      .from(tradeFlowAnalytics)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(tradeFlowAnalytics.accelerationScore), desc(tradeFlowAnalytics.asOfYear))
      .limit(limit);

    return reply.send({ analytics: rows, count: rows.length, limit });
  });

  // ── POST /api/agents/trade-analytics/run ──────────────────────────────────
  // Fire-and-forget trigger for TradeFlowAnalyticsEngine.
  // Requires TradeFlowIntelligenceAgent to have run first (populates annual data).
  // Optional body: { forceRefresh: boolean } — bypasses monthly/competitor cache.

  app.post('/api/agents/trade-analytics/run', async (request, reply) => {
    const { forceRefresh = false } = (request.body as { forceRefresh?: boolean }) ?? {};

    const { TradeFlowAnalyticsEngine } = await import('../agents/signals/trade-flow-analytics.js');
    const engine = new TradeFlowAnalyticsEngine();

    engine.run(forceRefresh).catch((err: unknown) => {
      logger.error({ err }, '[server] TradeFlowAnalyticsEngine background run failed');
    });

    return reply.code(202).send({
      accepted: true,
      message: 'Trade flow analytics run started',
      forceRefresh,
      note: 'Results appear in /api/trade-analytics once complete (~80 s fresh, <1 s cached)',
    });
  });

  // ── GET /api/ni-routing-signals ───────────────────────────────────────────
  // Query NI routing intelligence signals computed by NIRoutingAgent.
  // Filter by signal type, NCL category, EU country, or minimum strength.

  app.get('/api/ni-routing-signals', async (request, reply) => {
    const parsed = NiRoutingSignalsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid query parameters',
        code: 'VALIDATION_ERROR',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { signalType, nclCategory, euCountry, minStrength, limit } = parsed.data;

    const conditions: SQL[] = [
      signalType   ? eq(niRoutingSignals.signalType, signalType)        : undefined,
      nclCategory  ? eq(niRoutingSignals.nclCategory, nclCategory)      : undefined,
      euCountry    ? eq(niRoutingSignals.euCountry, euCountry)          : undefined,
      minStrength  !== undefined
        ? gte(niRoutingSignals.signalStrength, minStrength)             : undefined,
    ].filter((c): c is SQL => c !== undefined);

    const rows = await db
      .select()
      .from(niRoutingSignals)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(niRoutingSignals.signalStrength), desc(niRoutingSignals.computedAt))
      .limit(limit);

    return reply.send({ signals: rows, count: rows.length, limit });
  });

  // ── POST /api/agents/ni-routing/run ───────────────────────────────────────
  // Fire-and-forget trigger for NIRoutingAgent.
  // Requires trade flow intelligence data to be populated first.

  app.post('/api/agents/ni-routing/run', async (_request, reply) => {
    const { NIRoutingAgent } = await import('../agents/signals/ni-routing-agent.js');
    const agent = new NIRoutingAgent();

    agent.run().catch((err: unknown) => {
      logger.error({ err }, '[server] NIRoutingAgent background run failed');
    });

    return reply.code(202).send({
      accepted: true,
      message: 'NI routing intelligence run started',
      note: 'Results appear in /api/ni-routing-signals once complete',
    });
  });

  // ── GET /api/opportunity-correlations ─────────────────────────────────────
  // Compound intelligence bundles from CrossSignalCorrelationAgent.
  // Each bundle contains lead-lag analysis, trade show targets, and distributor
  // gap assessment for a (category, countryCode) corridor.

  app.get('/api/opportunity-correlations', async (request, reply) => {
    const parsed = CorrelationsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid query parameters',
        code: 'VALIDATION_ERROR',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { countryCode, category, tier, minScore, limit } = parsed.data;

    const conditions: SQL[] = [
      countryCode ? eq(opportunityCorrelations.countryCode, countryCode)              : undefined,
      category    ? eq(opportunityCorrelations.category, category)                    : undefined,
      tier        ? eq(opportunityCorrelations.opportunityTier, tier)                 : undefined,
      minScore !== undefined
        ? gte(opportunityCorrelations.compositeCorrelationScore, minScore)            : undefined,
    ].filter((c): c is SQL => c !== undefined);

    const rows = await db
      .select()
      .from(opportunityCorrelations)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(opportunityCorrelations.compositeCorrelationScore))
      .limit(limit);

    return reply.send({ correlations: rows, count: rows.length, limit });
  });

  // ── POST /api/agents/correlation/run ──────────────────────────────────────
  // Fire-and-forget trigger for CrossSignalCorrelationAgent.
  // Optionally scope to a specific country or category.
  // Runs best after trade-analytics, gap, and retailer agents have completed.

  app.post('/api/agents/correlation/run', async (request, reply) => {
    const { countryCode, category } = (request.body as {
      countryCode?: string;
      category?: string;
    }) ?? {};

    const { CrossSignalCorrelationAgent } = await import(
      '../agents/signals/cross-signal-correlation-agent.js'
    );
    const agent = new CrossSignalCorrelationAgent();

    agent.run({ countryCode, category }).catch((err: unknown) => {
      logger.error({ err }, '[server] CrossSignalCorrelationAgent background run failed');
    });

    return reply.code(202).send({
      accepted: true,
      message: 'Cross-signal correlation run started',
      note: 'Results appear in /api/opportunity-correlations once complete',
    });
  });

  // ── POST /api/agents/trends/run ───────────────────────────────────────────
  // Fire-and-forget trigger for TrendDetectionScheduler.runWeeklyDetection().
  // Runs full detection → validation → gap scoring pipeline.

  app.post('/api/agents/trends/run', async (_request, reply) => {
    const { TrendDetectionScheduler } = await import(
      '../agents/signals/trend-detection/trend-scheduler.js'
    );
    const scheduler = new TrendDetectionScheduler();

    scheduler.runWeeklyDetection().catch((err: unknown) => {
      logger.error({ err }, '[server] TrendDetectionScheduler background run failed');
    });

    return reply.code(202).send({
      accepted: true,
      message: 'Trend detection run started',
      note: 'Results appear in /api/trends and /api/human-review once complete (~1–2 min)',
    });
  });

  // ── GET /api/human-review ─────────────────────────────────────────────────
  // Returns items pending human review, ordered by priority desc then created asc.
  // Filterable by type (e.g. 'trend_validation') and status.

  app.get('/api/human-review', async (request, reply) => {
    const parsed = HumanReviewQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid query parameters',
        code: 'VALIDATION_ERROR',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { type, status, limit } = parsed.data;

    const conditions: SQL[] = [
      type   ? eq(humanReviewItems.type, type)     : undefined,
      status ? eq(humanReviewItems.status, status) : undefined,
    ].filter((c): c is SQL => c !== undefined);

    const rows = await db
      .select()
      .from(humanReviewItems)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(humanReviewItems.priority), asc(humanReviewItems.createdAt))
      .limit(limit);

    return reply.send({ items: rows, count: rows.length, limit });
  });

  // ── PATCH /api/human-review/:id ───────────────────────────────────────────
  // Approve or reject a human review item.
  // Body: { status: 'approved' | 'rejected', reviewedBy?: string, notes?: string }
  // Notes are merged into the existing validationResult JSONB as a top-level key.

  app.patch<{ Params: { id: string } }>('/api/human-review/:id', async (request, reply) => {
    const parsed = HumanReviewPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid request body',
        code: 'VALIDATION_ERROR',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { id } = request.params;
    const { status, reviewedBy, notes } = parsed.data;

    const existing = await db
      .select()
      .from(humanReviewItems)
      .where(eq(humanReviewItems.id, id))
      .limit(1);

    if (existing.length === 0) {
      return reply.code(404).send({ error: 'Review item not found', code: 'NOT_FOUND' });
    }

    const updatedValidation = notes
      ? { ...(existing[0].validationResult as object ?? {}), reviewerNotes: notes }
      : existing[0].validationResult;

    await db
      .update(humanReviewItems)
      .set({
        status,
        reviewedBy:       reviewedBy ?? null,
        reviewedAt:       new Date(),
        validationResult: updatedValidation as any,
      })
      .where(eq(humanReviewItems.id, id));

    // When a lead_outreach item is approved, advance the lead to 'contacted'
    if (existing[0].type === 'lead_outreach' && status === 'approved') {
      const itemData = existing[0].data as Record<string, unknown>;
      const leadId = itemData.leadId as string | undefined;
      if (leadId) {
        await db
          .update(leads)
          .set({ status: 'contacted', updatedAt: new Date() })
          .where(eq(leads.id, leadId));
        logger.info({ leadId, reviewItemId: id }, 'Lead advanced to contacted on outreach approval');
      }
    }

    return reply.send({ id, status, reviewedAt: new Date().toISOString() });
  });

  // ── PATCH /api/leads/:id ──────────────────────────────────────────────────
  // Update lead status (approve/reject from leads dashboard).

  app.patch<{ Params: { id: string } }>('/api/leads/:id', async (request, reply) => {
    const parsed = LeadPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid request body',
        code: 'VALIDATION_ERROR',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { id } = request.params;
    const { status, assignedTo, notes } = parsed.data;

    const existing = await db
      .select({ id: leads.id })
      .from(leads)
      .where(eq(leads.id, id))
      .limit(1);

    if (existing.length === 0) {
      return reply.code(404).send({ error: 'Lead not found', code: 'NOT_FOUND' });
    }

    await db
      .update(leads)
      .set({
        status,
        ...(assignedTo !== undefined ? { assignedTo } : {}),
        ...(notes !== undefined      ? { notes }      : {}),
        updatedAt: new Date(),
      })
      .where(eq(leads.id, id));

    return reply.send({ id, status });
  });

  // ── GET /api/opportunity-scores ───────────────────────────────────────────
  // Corridor-level composite scores (brandId = null), ordered by compositeScore desc.
  // Filterable by country, category, and minimum composite score threshold.

  app.get('/api/opportunity-scores', async (request, reply) => {
    const parsed = OpportunityScoresQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid query parameters',
        code: 'VALIDATION_ERROR',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { countryCode, category, minComposite, limit } = parsed.data;

    const conditions: SQL[] = [
      sql`${opportunityScores.brandId} IS NULL`,
      countryCode   ? eq(opportunityScores.countryCode, countryCode)     : undefined,
      category      ? eq(opportunityScores.category, category)           : undefined,
      minComposite !== undefined
        ? gte(opportunityScores.compositeScore, minComposite)            : undefined,
    ].filter((c): c is SQL => c !== undefined);

    const rows = await db
      .select()
      .from(opportunityScores)
      .where(and(...conditions))
      .orderBy(desc(opportunityScores.compositeScore))
      .limit(limit);

    return reply.send({ scores: rows, count: rows.length, limit });
  });

  // ── POST /api/agents/composite-scoring/run ────────────────────────────────
  // Fire-and-forget trigger for CompositeScoringAgent.
  // Best run after trends, gap, retailer, and correlation agents have completed.

  app.post('/api/agents/composite-scoring/run', async (_request, reply) => {
    const { CompositeScoringAgent } = await import(
      '../agents/signals/composite-scoring-agent.js'
    );
    const agent = new CompositeScoringAgent();

    agent.run().catch((err: unknown) => {
      logger.error({ err }, '[server] CompositeScoringAgent background run failed');
    });

    return reply.code(202).send({
      accepted: true,
      message: 'Composite scoring run started',
      note: 'Results appear in /api/opportunity-scores once complete',
    });
  });

  // ── GET /api/insights ─────────────────────────────────────────────────────
  // Query generated insights. Filterable by type and status.

  app.get('/api/insights', async (request, reply) => {
    const InsightsQuerySchema = z.object({
      type:   z.enum(['opportunity_alert', 'market_brief', 'trade_show_playbook', 'weekly_report']).optional(),
      status: z.enum(['draft', 'published', 'sent']).optional(),
      limit:  z.coerce.number().int().min(1).max(100).default(50),
    });
    const parsed = InsightsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid query parameters', code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors });
    }
    const { type, status, limit } = parsed.data;

    const conditions: SQL[] = [
      type   ? eq(insights.type,   type   as 'opportunity_alert' | 'market_brief' | 'trade_show_playbook' | 'weekly_report') : undefined,
      status ? eq(insights.status, status as 'draft' | 'published' | 'sent') : undefined,
    ].filter((c): c is SQL => c !== undefined);

    const rows = await db
      .select({ id: insights.id, type: insights.type, title: insights.title, status: insights.status, createdAt: insights.createdAt })
      .from(insights)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(insights.createdAt))
      .limit(limit);

    return reply.send({ insights: rows, count: rows.length, limit });
  });

  // ── POST /api/agents/insights/run ────────────────────────────────────────
  // Fire-and-forget trigger for InsightGenerationAgent.
  // Best run after CompositeScoringAgent and BrandFitScoringAgent have completed.

  app.post('/api/agents/insights/run', async (_request, reply) => {
    const { InsightGenerationAgent } = await import('../agents/signals/insight-generation-agent.js');
    const agent = new InsightGenerationAgent();

    agent.run().catch((err: unknown) => {
      logger.error({ err }, '[server] InsightGenerationAgent background run failed');
    });

    return reply.code(202).send({
      accepted: true,
      message: 'Insight generation run started',
      note: 'Results appear in /api/insights once complete',
    });
  });

  // ── POST /api/agents/brand-fit/run ────────────────────────────────────────
  // Fire-and-forget trigger for BrandFitScoringAgent.
  // Requires CompositeScoringAgent to have run first (corridor rows must exist).

  app.post('/api/agents/brand-fit/run', async (_request, reply) => {
    const { BrandFitScoringAgent } = await import(
      '../agents/signals/brand-fit-scoring-agent.js'
    );
    const agent = new BrandFitScoringAgent();

    agent.run().catch((err: unknown) => {
      logger.error({ err }, '[server] BrandFitScoringAgent background run failed');
    });

    return reply.code(202).send({
      accepted: true,
      message: 'Brand fit scoring run started',
      note: 'Results appear in /api/opportunity-scores (brandId IS NOT NULL) once complete',
    });
  });

  // ── GET /api/brand-scores ────────────────────────────────────────────────
  // Brand-specific opportunity scores (brandId IS NOT NULL), joined with brand name.
  // Filterable by category, country, and minimum composite score.
  // Ordered by compositeScore desc.

  app.get('/api/brand-scores', async (request, reply) => {
    const BrandScoresQuerySchema = z.object({
      countryCode:   z.string().length(2).toUpperCase().optional(),
      category:      z.string().min(1).optional(),
      minComposite:  z.coerce.number().min(0).max(100).optional(),
      limit:         z.coerce.number().int().min(1).max(200).default(50),
    });
    const parsed = BrandScoresQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid query parameters',
        code: 'VALIDATION_ERROR',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const { countryCode, category, minComposite, limit } = parsed.data;

    const conditions: SQL[] = [
      sql`${opportunityScores.brandId} IS NOT NULL`,
      countryCode  ? eq(opportunityScores.countryCode, countryCode)       : undefined,
      category     ? eq(opportunityScores.category, category)             : undefined,
      minComposite !== undefined
        ? gte(opportunityScores.compositeScore, minComposite)             : undefined,
    ].filter((c): c is SQL => c !== undefined);

    const rows = await db
      .select({
        id:                       opportunityScores.id,
        brandId:                  opportunityScores.brandId,
        brandName:                brands.name,
        euPresence:               brands.euPresence,
        annualRevenueEstimate:    brands.annualRevenueEstimate,
        shopifyStoreUrl:          brands.shopifyStoreUrl,
        category:                 opportunityScores.category,
        countryCode:              opportunityScores.countryCode,
        compositeScore:           opportunityScores.compositeScore,
        categoryOpportunityScore: opportunityScores.categoryOpportunityScore,
        brandFitScore:            opportunityScores.brandFitScore,
        niSuitabilityPreScore:    opportunityScores.niSuitabilityPreScore,
        scoringFactors:           opportunityScores.scoringFactors,
        generatedAt:              opportunityScores.generatedAt,
      })
      .from(opportunityScores)
      .innerJoin(brands, eq(opportunityScores.brandId, brands.id))
      .where(and(...conditions))
      .orderBy(desc(opportunityScores.compositeScore))
      .limit(limit);

    return reply.send({ scores: rows, count: rows.length, limit });
  });

  // ── GET /api/trade-show-playbooks ─────────────────────────────────────────
  // Query structured trade show playbooks produced by TradeShowPlaybookAgent.
  // Returns playbooks with show metadata joined inline.
  // Filterable by status; ordered by generatedAt desc.

  app.get('/api/trade-show-playbooks', async (request, reply) => {
    const TradeShowPlaybooksQuerySchema = z.object({
      status: z.enum(['draft', 'published']).optional(),
      limit:  z.coerce.number().int().min(1).max(50).default(20),
    });
    const parsed = TradeShowPlaybooksQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid query parameters',
        code: 'VALIDATION_ERROR',
        details: parsed.error.flatten().fieldErrors,
      });
    }
    const { status, limit } = parsed.data;

    const conditions: SQL[] = [
      status ? eq(tradeShowPlaybooks.status, status) : undefined,
    ].filter((c): c is SQL => c !== undefined);

    const rows = await db
      .select({
        id:                  tradeShowPlaybooks.id,
        tradeShowId:         tradeShowPlaybooks.tradeShowId,
        showName:            tradeShows.name,
        showLocation:        tradeShows.location,
        showStartDate:       tradeShows.startDate,
        showEndDate:         tradeShows.endDate,
        matchedCategories:   tradeShowPlaybooks.matchedCategories,
        relevantCorridors:   tradeShowPlaybooks.relevantCorridors,
        exhibitorMatches:    tradeShowPlaybooks.exhibitorMatches,
        distributorCoverage: tradeShowPlaybooks.distributorCoverage,
        topPipelineBrands:   tradeShowPlaybooks.topPipelineBrands,
        totalExhibitors:     tradeShowPlaybooks.totalExhibitors,
        matchedExhibitors:   tradeShowPlaybooks.matchedExhibitors,
        narrative:           tradeShowPlaybooks.narrative,
        status:              tradeShowPlaybooks.status,
        generatedAt:         tradeShowPlaybooks.generatedAt,
      })
      .from(tradeShowPlaybooks)
      .innerJoin(tradeShows, eq(tradeShowPlaybooks.tradeShowId, tradeShows.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(tradeShowPlaybooks.generatedAt))
      .limit(limit);

    return reply.send({ playbooks: rows, count: rows.length, limit });
  });

  // ── POST /api/agents/trade-show-playbook/run ──────────────────────────────
  // Fire-and-forget trigger for TradeShowPlaybookAgent.
  // Processes all upcoming trade shows, cross-references exhibitors against
  // the brands DB, and generates structured playbooks with distributor coverage.

  app.post('/api/agents/trade-show-playbook/run', async (_request, reply) => {
    const { TradeShowPlaybookAgent } = await import(
      '../agents/signals/trade-show-playbook-agent.js'
    );
    const agent = new TradeShowPlaybookAgent();

    agent.run().catch((err: unknown) => {
      logger.error({ err }, '[server] TradeShowPlaybookAgent background run failed');
    });

    return reply.code(202).send({
      accepted: true,
      message: 'Trade show playbook run started',
      note: 'Results appear in /api/trade-show-playbooks once complete',
    });
  });

  // ── GET /api/leads ────────────────────────────────────────────────────────
  // List leads with quality score, status, pitch angle, and discovery source.

  app.get('/api/leads', async (request, reply) => {
    const LeadsQuerySchema = z.object({
      status:    z.enum(['new','reviewed','approved','contacted','replied','qualified','won','lost','invalid']).optional(),
      source:    z.string().min(1).optional(),
      minScore:  z.coerce.number().min(0).max(100).optional(),
      category:  z.string().min(1).optional(),
      limit:     z.coerce.number().int().min(1).max(200).default(50),
    });
    const parsed = LeadsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid query parameters', code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors });
    }
    const { status, source, minScore, category, limit } = parsed.data;

    const conditions: SQL[] = [
      status   ? eq(leads.status, status as 'new') : undefined,
      source   ? eq(leads.discoverySource, source) : undefined,
      category ? eq(leads.bestCategory, category)  : undefined,
      minScore !== undefined ? gte(leads.leadQualityScore, minScore) : undefined,
    ].filter((c): c is SQL => c !== undefined);

    const rows = await db
      .select()
      .from(leads)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(leads.leadQualityScore))
      .limit(limit);

    return reply.send({ leads: rows, count: rows.length, limit });
  });

  // ── GET /api/leads/:id ────────────────────────────────────────────────────

  app.get<{ Params: { id: string } }>('/api/leads/:id', async (request, reply) => {
    const { id } = request.params;
    const lead = await db.select().from(leads).where(eq(leads.id, id)).limit(1);
    if (lead.length === 0) return reply.code(404).send({ error: 'Lead not found', code: 'NOT_FOUND' });

    const [campaigns, pipeline] = await Promise.all([
      db.select().from(leadCampaigns).where(eq(leadCampaigns.leadId, id)).orderBy(desc(leadCampaigns.createdAt)),
      db.select().from(leadPipeline).where(eq(leadPipeline.leadId, id)).limit(1),
    ]);

    return reply.send({ lead: lead[0], campaigns, pipeline: pipeline[0] ?? null });
  });

  // ── PATCH /api/leads/:id ──────────────────────────────────────────────────

  app.patch<{ Params: { id: string } }>('/api/leads/:id', async (request, reply) => {
    const LeadPatchSchema = z.object({
      status:     z.enum(['new','reviewed','approved','contacted','replied','qualified','won','lost','invalid']).optional(),
      assignedTo: z.string().optional(),
      notes:      z.string().optional(),
    });
    const parsed = LeadPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request body', code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors });
    }
    const { id } = request.params;
    const updates = { ...parsed.data, updatedAt: new Date() };
    await db.update(leads).set(updates).where(eq(leads.id, id));
    return reply.send({ id, ...updates });
  });

  // ── GET /api/campaigns ────────────────────────────────────────────────────

  app.get('/api/campaigns', async (request, reply) => {
    const CampaignsQuerySchema = z.object({
      leadId: z.string().uuid().optional(),
      status: z.string().optional(),
      limit:  z.coerce.number().int().min(1).max(100).default(50),
    });
    const parsed = CampaignsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid query parameters', code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors });
    }
    const { leadId, status, limit } = parsed.data;

    const conditions: SQL[] = [
      leadId ? eq(leadCampaigns.leadId, leadId) : undefined,
      status ? eq(leadCampaigns.status, status) : undefined,
    ].filter((c): c is SQL => c !== undefined);

    const rows = await db
      .select()
      .from(leadCampaigns)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(leadCampaigns.createdAt))
      .limit(limit);

    return reply.send({ campaigns: rows, count: rows.length, limit });
  });

  // ── POST /api/campaigns/:id/send ──────────────────────────────────────────

  app.post<{ Params: { id: string } }>('/api/campaigns/:id/send', async (request, reply) => {
    const { id } = request.params;
    const campaign = await db.select().from(leadCampaigns).where(eq(leadCampaigns.id, id)).limit(1);
    if (campaign.length === 0) return reply.code(404).send({ error: 'Campaign not found', code: 'NOT_FOUND' });
    if (campaign[0].status !== 'approved') {
      return reply.code(400).send({ error: 'Campaign must be approved before sending', code: 'NOT_APPROVED' });
    }

    const lead = await db.select({ email: leads.email, companyName: leads.companyName }).from(leads).where(eq(leads.id, campaign[0].leadId)).limit(1);
    if (!lead[0]?.email) return reply.code(400).send({ error: 'Lead has no email address', code: 'NO_EMAIL' });

    const { sendEmail } = await import('../lib/email.js');
    const sendResult = await sendEmail({
      to: lead[0].email,
      subject: campaign[0].subject,
      html: `<pre style="font-family:sans-serif;white-space:pre-wrap">${campaign[0].body}</pre>`,
    });
    const resendId = sendResult?.data?.id ?? null;

    await db.update(leadCampaigns)
      .set({ status: 'sent', sentAt: new Date(), resendMessageId: resendId })
      .where(eq(leadCampaigns.id, id));

    await db.update(leads).set({ status: 'contacted', updatedAt: new Date() }).where(eq(leads.id, campaign[0].leadId));

    return reply.send({ sent: true, resendMessageId: resendId });
  });

  // ── GET /api/lead-pipeline ────────────────────────────────────────────────

  app.get('/api/lead-pipeline', async (_request, reply) => {
    const stages = await db
      .select({
        stage: leadPipeline.stage,
        count: sql<number>`cast(count(*) as int)`,
        totalValue: sql<number>`cast(coalesce(sum(estimated_value), 0) as float)`,
      })
      .from(leadPipeline)
      .groupBy(leadPipeline.stage)
      .orderBy(leadPipeline.stage);

    const totalLeads = stages.reduce((acc, s) => acc + s.count, 0);
    const totalEstimatedValue = stages.reduce((acc, s) => acc + s.totalValue, 0);

    return reply.send({ stages, totalLeads, totalEstimatedValue });
  });

  // ── POST /api/agents/lead-discovery/run ──────────────────────────────────

  app.post('/api/agents/lead-discovery/run', async (_request, reply) => {
    const { LeadDiscoveryAgent } = await import('../agents/lead-gen/lead-discovery-agent.js');
    const agent = new LeadDiscoveryAgent();
    agent.run().catch((err: unknown) => logger.error({ err }, '[server] LeadDiscoveryAgent failed'));
    return reply.code(202).send({ accepted: true, message: 'Lead discovery started', note: 'Results appear in /api/leads once complete' });
  });

  // ── POST /api/agents/lead-scoring/run ────────────────────────────────────

  app.post('/api/agents/lead-scoring/run', async (_request, reply) => {
    const { LeadScoringAgent } = await import('../agents/lead-gen/lead-scoring-agent.js');
    const agent = new LeadScoringAgent();
    agent.run().catch((err: unknown) => logger.error({ err }, '[server] LeadScoringAgent failed'));
    return reply.code(202).send({ accepted: true, message: 'Lead scoring started' });
  });

  // ── POST /api/agents/pitch-angles/run ────────────────────────────────────

  app.post('/api/agents/pitch-angles/run', async (_request, reply) => {
    const { PitchAngleAgent } = await import('../agents/lead-gen/pitch-angle-agent.js');
    const agent = new PitchAngleAgent();
    agent.run().catch((err: unknown) => logger.error({ err }, '[server] PitchAngleAgent failed'));
    return reply.code(202).send({ accepted: true, message: 'Pitch angle generation started' });
  });

  // ── POST /api/agents/lead-outreach/run ───────────────────────────────────

  app.post('/api/agents/lead-outreach/run', async (_request, reply) => {
    const { LeadOutreachAgent } = await import('../agents/lead-gen/lead-outreach-agent.js');
    const agent = new LeadOutreachAgent();
    agent.run().catch((err: unknown) => logger.error({ err }, '[server] LeadOutreachAgent failed'));
    return reply.code(202).send({ accepted: true, message: 'Lead outreach run started', note: 'Approved leads above quality threshold will be queued for review' });
  });

  // ── POST /api/agents/crm-export/run ──────────────────────────────────────

  app.post('/api/agents/crm-export/run', async (_request, reply) => {
    const { CRMExportAgent } = await import('../agents/lead-gen/crm-export-agent.js');
    const agent = new CRMExportAgent();
    agent.run().catch((err: unknown) => logger.error({ err }, '[server] CRMExportAgent failed'));
    return reply.code(202).send({ accepted: true, message: 'CRM export started', note: 'Export file written to exports/ directory' });
  });

  // ── POST /api/webhooks/resend ─────────────────────────────────────────────
  // Resend webhook receiver. Always returns 200 on success to prevent retries.
  // Verifies the svix HMAC signature against RESEND_WEBHOOK_SECRET; rejects
  // with 401 on signature mismatch so engagement events cannot be forged.
  // When RESEND_WEBHOOK_SECRET is not configured (local dev), signature checks
  // are bypassed but a warning is logged on every call.

  app.post('/api/webhooks/resend', async (request, reply) => {
    const secret = process.env.RESEND_WEBHOOK_SECRET;
    const rawBody = (request as { rawBody?: string }).rawBody;

    if (secret) {
      if (!rawBody) {
        logger.warn('Resend webhook missing raw body — cannot verify signature');
        return reply.code(400).send({ error: 'No body', code: 'NO_BODY' });
      }

      const svixId        = request.headers['svix-id'];
      const svixTimestamp = request.headers['svix-timestamp'];
      const svixSignature = request.headers['svix-signature'];

      if (typeof svixId !== 'string' || typeof svixTimestamp !== 'string' || typeof svixSignature !== 'string') {
        logger.warn({ svixId, svixTimestamp, svixSignature }, 'Resend webhook missing svix headers');
        return reply.code(401).send({ error: 'Missing signature headers', code: 'MISSING_SIGNATURE' });
      }

      try {
        const { Webhook } = await import('svix');
        const wh = new Webhook(secret);
        wh.verify(rawBody, {
          'svix-id': svixId,
          'svix-timestamp': svixTimestamp,
          'svix-signature': svixSignature,
        });
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'Resend webhook signature verification failed');
        return reply.code(401).send({ error: 'Invalid signature', code: 'INVALID_SIGNATURE' });
      }
    } else {
      logger.warn('RESEND_WEBHOOK_SECRET not configured — accepting webhook without signature verification');
    }

    try {
      const event = request.body as { type: string; data: { message_id?: string; bounce?: { type: string; message: string }; to?: string[]; text?: string } };
      const { LeadEngagementAgent } = await import('../agents/lead-gen/lead-engagement-agent.js');
      const agent = new LeadEngagementAgent();
      await agent.handleWebhookEvent(event);
    } catch (err) {
      logger.error({ err }, 'Resend webhook handler error');
    }

    return reply.code(200).send({ received: true });
  });

  // ── POST /api/agents/report-generator/run ────────────────────────────────
  // Fire-and-forget trigger for ReportGeneratorAgent.
  // Generates weekly digest and monthly market brief insights.

  app.post('/api/agents/report-generator/run', async (_request, reply) => {
    const { ReportGeneratorAgent } = await import('../agents/signals/report-generator-agent.js');
    const agent = new ReportGeneratorAgent();

    agent.run().catch((err: unknown) => {
      logger.error({ err }, '[server] ReportGeneratorAgent background run failed');
    });

    return reply.code(202).send({
      accepted: true,
      message: 'Report generation started',
      note: 'Results appear in /api/insights (types: weekly_report, market_brief) once complete',
    });
  });

  // ── POST /api/agents/trigger-rules/run ───────────────────────────────────
  // Fire-and-forget trigger for TriggerRulesEngine.
  // Evaluates all active trigger_rules against current opportunity_scores.

  app.post('/api/agents/trigger-rules/run', async (_request, reply) => {
    const { TriggerRulesEngine } = await import('../agents/trigger-rules-engine.js');
    const engine = new TriggerRulesEngine();

    engine.run().catch((err: unknown) => {
      logger.error({ err }, '[server] TriggerRulesEngine background run failed');
    });

    return reply.code(202).send({
      accepted: true,
      message: 'Trigger rules evaluation started',
      note: 'Fires alerts and queues leads for corridors that exceed rule thresholds',
    });
  });

  // ── POST /api/agents/master-scheduler/run ────────────────────────────────
  // Fire-and-forget trigger for MasterSchedulerAgent.
  // Runs the full pipeline: trade flow → analytics → NI routing → crawlers →
  // trend scheduler → lead-gen chain → trigger rules.

  app.post('/api/agents/master-scheduler/run', async (_request, reply) => {
    const { MasterSchedulerAgent } = await import('../agents/master-scheduler.js');
    const agent = new MasterSchedulerAgent();

    agent.run().catch((err: unknown) => {
      logger.error({ err }, '[server] MasterSchedulerAgent background run failed');
    });

    return reply.code(202).send({
      accepted: true,
      message: 'Full pipeline run started',
      note: 'Runs all agents sequentially; check /api/crawl-jobs and /api/insights for progress',
    });
  });

  return app;
}
