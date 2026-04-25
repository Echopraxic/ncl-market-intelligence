import { buildServer } from './api/server.js';
import { logger } from './lib/logger.js';
import { CrawlerScheduler } from './agents/crawlers/scheduler.js';
import { TradeShowCrawler } from './agents/crawlers/trade-show-crawler.js';
import { ShopifyBrandCrawler } from './agents/crawlers/shopify-brand-crawler.js';
import { GoogleTrendsCrawler } from './agents/crawlers/google-trends-crawler.js';
import { AmazonEUCrawler } from './agents/crawlers/amazon-eu-crawler.js';

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const HOST = process.env.HOST ?? '0.0.0.0';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

async function main() {
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

    scheduler.register('trade-show',    () => new TradeShowCrawler(),    '0 3 * * 1');
    scheduler.register('shopify-brand', () => new ShopifyBrandCrawler(), '0 3 * * 2');
    scheduler.register('google-trends', () => new GoogleTrendsCrawler(), '0 3 * * 3');
    scheduler.register('amazon-eu',     () => new AmazonEUCrawler(),     '0 3 * * 4');

    logger.info({ crawlers: scheduler.registeredCrawlers() }, 'Crawlers registered');
  } catch (err) {
    logger.warn({ error: (err as Error).message }, 'Scheduler failed to initialise — API will run without queue support (requires Redis 5+)');
    scheduler = undefined;
  }

  // Absorb async BullMQ connection errors so the process does not crash when
  // Redis is unavailable or is an incompatible version.
  process.on('unhandledRejection', (reason) => {
    logger.warn({ reason: String(reason) }, 'Unhandled rejection (likely BullMQ/Redis) — ignoring');
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
