import { db } from '@/db/index.js';
import { crawlJobs } from '@/db/schema.js';
import { logger } from '@/lib/logger.js';
import { eq } from 'drizzle-orm';
import { Page } from 'playwright';
import * as cheerio from 'cheerio';
import { CrawlErrorCode, StructuredCrawlError, classifyError } from '@/lib/crawler-errors.js';

export type CrawlResult = {
  crawlerType: string;
  recordsFound: number;
  newRecordsFound: number;
  pagesScraped: number;
  errors: string[];
  structuredErrors: StructuredCrawlError[];
};

// Stub for proxy rotation — wired up in a later phase when a proxy provider is selected.
export type ProxyConfig = {
  host: string;
  port: number;
  username?: string;
  password?: string;
};

export abstract class BaseCrawler {
  abstract readonly crawlerType: string;

  protected readonly rateLimitMs: number;
  protected readonly maxRetries: number;
  protected readonly timeoutMs: number;
  protected currentRateLimitMs: number;
  private readonly minRateLimitMs = 500;
  private readonly maxRateLimitMs = 60_000;
  private readonly proxies: ProxyConfig[];
  private proxyIndex = 0;
  private uaIndex = 0;

  private readonly userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Edg/130.0.0.0',
  ];

  constructor({
    rateLimitMs,
    maxRetries,
    timeoutMs,
    proxies,
  }: {
    rateLimitMs?: number;
    maxRetries?: number;
    /** Maximum total runtime for a crawl job. Defaults to 10 minutes. */
    timeoutMs?: number;
    proxies?: ProxyConfig[];
  } = {}) {
    this.rateLimitMs = rateLimitMs ?? Number(process.env.CRAWLER_RATE_LIMIT_MS ?? 2000);
    this.currentRateLimitMs = this.rateLimitMs;
    this.maxRetries = maxRetries ?? 3;
    this.timeoutMs = timeoutMs ?? 10 * 60 * 1000; // 10 minutes
    this.proxies = proxies ?? [];
  }

  /** Implement all crawl logic here. Called by runWithTracking. */
  abstract run(): Promise<CrawlResult>;

  /**
   * Wraps run() with crawl_jobs DB tracking.
   * Inserts a 'running' record before, updates to 'completed' or 'failed' after.
   */
  async runWithTracking(): Promise<CrawlResult> {
    const [job] = await db
      .insert(crawlJobs)
      .values({
        crawlerType: this.crawlerType,
        status: 'running',
        startedAt: new Date(),
      })
      .returning();

    const log = logger.child({ crawlerType: this.crawlerType, jobId: job.id });
    log.info('Crawler job started');

    const startMs = Date.now();

    try {
      const timeoutError = new Error(`Crawler timed out after ${this.timeoutMs / 1000}s`);
      const result = await Promise.race([
        this.run(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(timeoutError), this.timeoutMs),
        ),
      ]);

      const durationMs = Date.now() - startMs;

      await db
        .update(crawlJobs)
        .set({
          status: 'completed',
          completedAt: new Date(),
          recordsFound: result.recordsFound,
          errorLog: result.errors.length > 0 ? result.errors.join('\n') : null,
          durationMs,
          pagesCrawled: result.pagesScraped,
          lastFreshAt: result.newRecordsFound > 0 ? new Date() : null,
          errorDetails: result.structuredErrors as unknown as Record<string, unknown>,
        })
        .where(eq(crawlJobs.id, job.id));

      log.info({ recordsFound: result.recordsFound, durationMs, pagesCrawled: result.pagesScraped }, 'Crawler job completed');
      return result;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - startMs;
      const errorCode = classifyError(errorMsg);
      const structuredError: StructuredCrawlError = {
        code: errorCode,
        message: errorMsg,
        retryable: false,
        timestamp: new Date().toISOString(),
      };

      await db
        .update(crawlJobs)
        .set({
          status: 'failed',
          completedAt: new Date(),
          errorLog: errorMsg,
          durationMs,
          errorDetails: [structuredError] as unknown as Record<string, unknown>,
        })
        .where(eq(crawlJobs.id, job.id));

      log.error({ error: errorMsg, durationMs }, 'Crawler job failed');
      throw err;
    }
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  protected getNextUserAgent(): string {
    const ua = this.userAgents[this.uaIndex];
    this.uaIndex = (this.uaIndex + 1) % this.userAgents.length;
    return ua;
  }

  protected adjustRateLimit(event: 'success' | 'rate_limited' | 'bot_blocked'): void {
    const oldRate = this.currentRateLimitMs;
    if (event === 'success') {
      this.currentRateLimitMs = Math.max(this.minRateLimitMs, Math.round(this.currentRateLimitMs * 0.85));
    } else if (event === 'rate_limited') {
      this.currentRateLimitMs = Math.min(this.maxRateLimitMs, this.currentRateLimitMs * 2);
    } else if (event === 'bot_blocked') {
      this.currentRateLimitMs = Math.min(this.maxRateLimitMs, this.currentRateLimitMs * 3);
    }
    if (oldRate !== this.currentRateLimitMs) {
      logger.debug({ event, oldRate, newRate: this.currentRateLimitMs }, 'Rate limit adjusted');
    }
  }

  protected async respectRetryAfter(headers: { get(k: string): string | null }): Promise<void> {
    const retryAfter = headers.get('Retry-After');
    let delaySec = 60;
    if (retryAfter) {
      const parsed = parseInt(retryAfter, 10);
      if (!isNaN(parsed)) {
        delaySec = parsed;
      }
    }
    logger.warn({ delaySec }, 'Respecting Retry-After header');
    await this.sleep(delaySec * 1000);
    this.adjustRateLimit('rate_limited');
  }

  protected async captureRenderedDOM(
    page: Page,
    opts: { waitSelector?: string; postLoadDelayMs?: number } = {},
  ): Promise<{ html: string; loadTimeMs: number }> {
    const startMs = Date.now();
    if (opts.waitSelector) {
      try {
        await page.waitForSelector(opts.waitSelector, { timeout: 5000 });
      } catch {
        logger.debug({ selector: opts.waitSelector }, 'Selector wait timeout (non-fatal)');
      }
    }
    if (opts.postLoadDelayMs) {
      await this.sleep(opts.postLoadDelayMs);
    }
    const html = await page.content();
    const loadTimeMs = Date.now() - startMs;
    return { html, loadTimeMs };
  }

  protected measureSelectorConfidence(
    $: ReturnType<typeof cheerio.load>,
    checks: Array<{ name: string; selector: string; expectedMin: number }>,
  ): Record<string, { found: number; expectedMin: number; confidence: number }> {
    const result: Record<string, { found: number; expectedMin: number; confidence: number }> = {};
    for (const check of checks) {
      const found = $(check.selector).length;
      const confidence = Math.min(1, found / check.expectedMin);
      result[check.name] = { found, expectedMin: check.expectedMin, confidence };
      if (confidence < 0.5) {
        logger.warn({ selector: check.selector, found, expectedMin: check.expectedMin, confidence }, 'Low selector confidence');
      }
    }
    return result;
  }

  /**
   * Retry wrapper with exponential backoff.
   * Delays: 1s, 2s, 4s (capped at 30s per attempt).
   */
  protected async withRetry<T>(
    fn: () => Promise<T>,
    label: string,
    retries = this.maxRetries,
  ): Promise<T> {
    let lastError: Error = new Error('Unknown error');

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const delay = Math.min(1000 * 2 ** (attempt - 1), 30_000);
        logger.warn(
          { label, attempt, retries, error: lastError.message, delayMs: delay },
          'Crawler retrying after error',
        );
        await this.sleep(delay);
      }
    }

    throw lastError;
  }

  /**
   * Round-robin proxy rotation.
   * Returns undefined when no proxies are configured (direct connection).
   */
  protected getNextProxy(): ProxyConfig | undefined {
    if (this.proxies.length === 0) return undefined;
    const proxy = this.proxies[this.proxyIndex];
    this.proxyIndex = (this.proxyIndex + 1) % this.proxies.length;
    return proxy;
  }

  /** Formats a ProxyConfig into the string format Playwright expects. */
  protected proxyToServer(proxy: ProxyConfig): { server: string; username?: string; password?: string } {
    return {
      server: `http://${proxy.host}:${proxy.port}`,
      username: proxy.username,
      password: proxy.password,
    };
  }
}
