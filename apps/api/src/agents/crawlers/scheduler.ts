import { Queue, Worker, type Job } from 'bullmq';
import { and, eq, gte } from 'drizzle-orm';
import { db } from '@/db/index.js';
import { euMarketSignals } from '@/db/schema.js';
import { logger } from '@/lib/logger.js';
import type { BaseCrawler, CrawlResult } from './base-crawler.js';

type CrawlerFactory = () => BaseCrawler;

type SchedulerOptions = {
  redisUrl: string;
};

const QUEUE_NAME = 'crawlers';
const NORMALIZATION_QUEUE_NAME = 'normalization' as const;

/**
 * Maps crawler types that produce eu_market_signals rows to their
 * corresponding `source` enum value so we can enqueue normalization jobs.
 */
const SIGNAL_SOURCE_MAP: Record<string, 'google_trends' | 'amazon_eu'> = {
  'google-trends': 'google_trends',
  'amazon-eu':     'amazon_eu',
};

/**
 * Manages crawler scheduling and execution via BullMQ.
 *
 * Usage:
 *   const scheduler = new CrawlerScheduler({ redisUrl: '...' });
 *   scheduler.register('trade-show', () => new TradeShowCrawler(), '0 3 * * 1'); // every Monday 3 AM
 *   await scheduler.trigger('trade-show'); // manual run
 */
export class CrawlerScheduler {
  private readonly queue: Queue;
  private readonly normalizationQueue: Queue;
  private readonly worker: Worker<Record<string, unknown>, CrawlResult>;
  private readonly factories = new Map<string, CrawlerFactory>();

  constructor({ redisUrl }: SchedulerOptions) {
    const connection = { url: redisUrl };

    this.queue = new Queue(QUEUE_NAME, { connection });
    this.normalizationQueue = new Queue(NORMALIZATION_QUEUE_NAME, { connection });

    this.worker = new Worker<Record<string, unknown>, CrawlResult>(
      QUEUE_NAME,
      async (job: Job) => {
        const factory = this.factories.get(job.name);
        if (!factory) {
          throw new Error(`No factory registered for crawler: ${job.name}`);
        }

        const crawler = factory();
        return crawler.runWithTracking();
      },
      {
        connection,
        // Process one crawler at a time to avoid overwhelming target sites.
        concurrency: 1,
      },
    );

    this.worker.on('completed', (job, result) => {
      logger.info(
        { crawlerType: job.name, recordsFound: result.recordsFound },
        'Crawler job completed',
      );
      void this.enqueueNormalization(job.name, result);
    });

    this.worker.on('failed', (job, err) => {
      logger.error(
        { crawlerType: job?.name, error: err.message },
        'Crawler job failed',
      );
    });
  }

  /**
   * Register a crawler with an optional cron schedule.
   *
   * @param crawlerType  - Unique identifier matching BaseCrawler.crawlerType
   * @param factory      - Function that creates a fresh crawler instance per run
   * @param cronSchedule - Standard cron string e.g. '0 3 * * 1' (optional)
   */
  register(
    crawlerType: string,
    factory: CrawlerFactory,
    cronSchedule?: string,
  ): void {
    this.factories.set(crawlerType, factory);

    if (cronSchedule) {
      // upsertJobScheduler is idempotent — safe to call on every startup.
      void this.queue.upsertJobScheduler(
        crawlerType,
        { pattern: cronSchedule },
        { name: crawlerType, data: {} },
      );
      logger.info({ crawlerType, cronSchedule }, 'Crawler scheduled');
    }
  }

  /**
   * Manually enqueue a crawler job outside its schedule.
   * Uses a timestamped jobId so multiple manual triggers don't deduplicate.
   */
  async trigger(crawlerType: string): Promise<void> {
    if (!this.factories.has(crawlerType)) {
      throw new Error(`Unknown crawler type: ${crawlerType}`);
    }
    await this.queue.add(crawlerType, {}, {
      jobId: `${crawlerType}-manual-${Date.now()}`,
    });
    logger.info({ crawlerType }, 'Crawler manually triggered');
  }

  /**
   * Run a crawler directly without going through BullMQ.
   * Used as a fallback when Redis is unavailable.
   * Returns immediately — the crawler runs asynchronously in the background.
   */
  runDirect(crawlerType: string): void {
    const factory = this.factories.get(crawlerType);
    if (!factory) {
      throw new Error(`Unknown crawler type: ${crawlerType}`);
    }
    logger.info({ crawlerType }, 'Running crawler directly (BullMQ unavailable)');
    const crawler = factory();
    void crawler.runWithTracking()
      .then((result) => {
        logger.info({ crawlerType, recordsFound: result.recordsFound }, 'Direct crawler run completed');
        void this.enqueueNormalization(crawlerType, result);
      })
      .catch((err: Error) => {
        logger.error({ crawlerType, error: err.message }, 'Direct crawler run failed');
      });
  }

  /** Returns the list of registered crawler types. */
  registeredCrawlers(): string[] {
    return Array.from(this.factories.keys());
  }

  /**
   * After a signal-producing crawler completes, query eu_market_signals for
   * records captured in the last 2 hours and push each to the normalization queue.
   * Only google-trends and amazon-eu crawlers produce eu_market_signals rows.
   */
  private async enqueueNormalization(crawlerType: string, result: CrawlResult): Promise<void> {
    const source = SIGNAL_SOURCE_MAP[crawlerType];
    if (!source || result.recordsFound === 0) return;

    const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000);

    const signals = await db
      .select({ id: euMarketSignals.id })
      .from(euMarketSignals)
      .where(and(
        eq(euMarketSignals.source, source),
        gte(euMarketSignals.capturedAt, cutoff),
      ));

    if (signals.length === 0) return;

    await Promise.all(
      signals.map((s) =>
        this.normalizationQueue.add('normalize', { signalId: s.id }),
      ),
    );

    logger.info(
      { crawlerType, source, enqueuedCount: signals.length },
      'Normalization jobs enqueued after crawler completion',
    );
  }

  async close(): Promise<void> {
    await this.worker.close();
    await this.queue.close();
    await this.normalizationQueue.close();
  }
}
