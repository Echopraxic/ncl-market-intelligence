import { buildServer } from './api/server.js';
import { logger } from './lib/logger.js';
import { runMigrations } from './db/migrate.js';
import { CrawlerScheduler } from './agents/crawlers/scheduler.js';
import { TradeShowCrawler } from './agents/crawlers/trade-show-crawler.js';
import { ShopifyBrandCrawler } from './agents/crawlers/shopify-brand-crawler.js';
import { GoogleTrendsCrawler } from './agents/crawlers/google-trends-crawler.js';
import { AmazonEUCrawler } from './agents/crawlers/amazon-eu-crawler.js';
import { CPGDirectoryCrawler } from './agents/crawlers/cpg-directory-crawler.js';
import { FaireCrawler } from './agents/crawlers/faire-crawler.js';
import { ThingTestingCrawler } from './agents/crawlers/thingtesting-crawler.js';
import { BulletinCrawler } from './agents/crawlers/bulletin-crawler.js';
import { IndustryDirectoryCrawler } from './agents/crawlers/industry-directory-crawler.js';

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const HOST = process.env.HOST ?? '0.0.0.0';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

async function main() {
  // -------------------------------------------------------------------------
  // Database migration (idempotent — safe to run on every startup)
  // -------------------------------------------------------------------------

  try {
    await runMigrations();
  } catch (err) {
    logger.error(err, 'DB migration failed — cannot start server');
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  // Crawler scheduler (BullMQ — requires Redis 5+)
  // -------------------------------------------------------------------------

  let scheduler: CrawlerScheduler | undefined;

  try {
    scheduler = new CrawlerScheduler({ redisUrl: REDIS_URL });

    // Cron schedules (all times UTC):
    //   trade-show      — every Monday at 03:00 (weekly metadata refresh)
    //   shopify-brand   — every Tuesday at 03:00 (weekly brand catalog refresh)
    //   google-trends   — every Wednesday at 03:00 (weekly trend pulse)
    //   amazon-eu       — every Thursday at 03:00 (weekly demand signal)

    // Cron schedules (all times UTC):
    //   Week A (market data):   trade-show Mon, shopify-brand Tue, google-trends Wed, amazon-eu Thu
    //   Week B (lead sources):  cpg-directory Fri, faire Sat, thingtesting Sun, bulletin Mon 06:00
    scheduler.register('trade-show',    () => new TradeShowCrawler(),    '0 3 * * 1');
    scheduler.register('shopify-brand', () => new ShopifyBrandCrawler(), '0 3 * * 2');
    scheduler.register('google-trends', () => new GoogleTrendsCrawler(), '0 3 * * 3');
    scheduler.register('amazon-eu',     () => new AmazonEUCrawler(),     '0 3 * * 4');
    scheduler.register('cpg-directory', () => new CPGDirectoryCrawler(), '0 3 * * 5');
    scheduler.register('faire',         () => new FaireCrawler(),         '0 3 * * 6');
    scheduler.register('thingtesting',  () => new ThingTestingCrawler(),  '0 3 * * 0');
    scheduler.register('bulletin',           () => new BulletinCrawler(),           '0 6 * * 1');
    scheduler.register('industry-directory', () => new IndustryDirectoryCrawler(),  '0 4 * * 2');

    logger.info({ crawlers: scheduler.registeredCrawlers() }, 'Crawlers registered');
  } catch (err) {
    logger.warn({ error: (err as Error).message }, 'Scheduler failed to initialise — API will run without queue support (requires Redis 5+)');
    scheduler = undefined;
  }

  // Absorb async BullMQ connection errors so the process does not crash when
  // Redis is unavailable or is an incompatible version. Only matches strings
  // that look like infrastructure noise — anything else is logged at error
  // level so real agent bugs are surfaced rather than silently swallowed.
  const REDIS_NOISE = /(Redis|BullMQ|ECONNREFUSED|NOAUTH|ETIMEDOUT|ENOTFOUND.*redis)/i;
  process.on('unhandledRejection', (reason) => {
    // AggregateError (e.g. from ioredis retry storms) often has an empty .message;
    // fall back to String(reason) which includes the class name and error code.
    const msg = reason instanceof Error
      ? (reason.message || String(reason))
      : String(reason);
    const code = (reason as { code?: string })?.code ?? '';
    if (REDIS_NOISE.test(msg) || REDIS_NOISE.test(code)) {
      logger.warn({ reason: msg || code }, 'Unhandled rejection from Redis/BullMQ — ignoring');
      return;
    }
    logger.error({ reason: msg, stack: reason instanceof Error ? reason.stack : undefined }, 'Unhandled rejection');
  });

  // -------------------------------------------------------------------------
  // HTTP server
  // -------------------------------------------------------------------------

  const server = await buildServer({ scheduler: scheduler ?? undefined });

  try {
    await server.listen({ port: PORT, host: HOST });
    logger.info({ host: HOST, port: PORT }, 'NCL MIE API started');
  } catch (err) {
    logger.error(err, 'Failed to start server');
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  // Graceful shutdown
  // -------------------------------------------------------------------------

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    await server.close();
    await scheduler?.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT',  () => void shutdown('SIGINT'));
}

main();
