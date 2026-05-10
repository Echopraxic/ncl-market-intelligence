import { chromium, type Browser } from 'playwright';
import * as cheerio from 'cheerio';
import { logger } from '@/lib/logger.js';
import { db } from '@/db/index.js';
import { agentOutputs } from '@/db/schema.js';
import { BaseLeadCrawler, type LeadCandidate } from './base-lead-crawler.js';
import { CrawlErrorCode, classifyError, type StructuredCrawlError } from '@/lib/crawler-errors.js';
import type { CrawlResult } from './base-crawler.js';

const MAX_PAGES_PER_DIRECTORY = 10;

interface DirectoryConfig {
  name: string;
  baseUrl: string;
  paginationParam: string;
  selectors: {
    card: string[];
    name: string[];
    website: string[];
    category: string[];
  };
  defaultCategory: string;
  pageUrlBuilder: (baseUrl: string, page: number, param: string) => string;
}

const DIRECTORIES: DirectoryConfig[] = [
  {
    name: 'cpgd',
    baseUrl: 'https://www.cpgd.xyz/brands',
    paginationParam: 'page',
    selectors: {
      card: ['.brand-card', '[class*="brand-card"]', '[class*="BrandCard"]', 'article', '.card', '.directory-item', '.brand-listing', '.listing'],
      name: ['h2', 'h3', '.brand-name', '[class*="name"]', '[class*="title"]', '.title', '.company-name'],
      website: [
        'a[href^="http"]:not([href*="cpgd.xyz"]):not([href*="cpgd.com"])',
        'a[href^="http"]',
      ],
      category: ['.category', '[class*="tag"]', '[class*="category"]', '[class*="type"]', '.tags span', '.meta span'],
    },
    defaultCategory: 'Consumer Packaged Goods',
    pageUrlBuilder: (baseUrl, page, param) =>
      page === 1 ? baseUrl : `${baseUrl}?${param}=${page}`,
  },
  {
    name: 'bevnet',
    baseUrl: 'https://www.bevnet.com/companies/',
    paginationParam: 'paged',
    selectors: {
      card: ['.company-card', '.listing-item', 'article', '.company-listing', '[class*="company"]', '.listing'],
      name: ['h2', 'h3', '.company-name', '.brand-name', '[class*="name"]', '[class*="title"]', '.title'],
      website: [
        'a[href^="http"]:not([href*="bevnet.com"])',
        'a[href^="http"]',
      ],
      category: ['.category', '.tags span', '[class*="tag"]', '[class*="category"]', '.meta span'],
    },
    defaultCategory: 'Beverage',
    pageUrlBuilder: (baseUrl, page, param) =>
      page === 1 ? baseUrl : `${baseUrl}?${param}=${page}`,
  },
];

export class CPGDirectoryCrawler extends BaseLeadCrawler {
  readonly crawlerType = 'cpg-directory';

  protected override readonly rateLimitMs = 2500;

  /** Fallback selector resolution — tries multiple selectors and returns the first match. */
  private resolveSelector($: cheerio.Root, element: cheerio.Element, selectors: string[]): cheerio.Cheerio {
    for (const selector of selectors) {
      const match = $(element).find(selector).first();
      if (match.length > 0) return match;
    }
    return $([]);
  }

  /** Build a confidence score using fallback selector lists. */
  private measureCardConfidence(
    $: cheerio.Root,
    checks: { name: string; selectors: string[]; expectedMin: number }[],
  ): Record<string, { confidence: number; matchedSelector: string | null; count: number }> {
    const result: Record<string, { confidence: number; matchedSelector: string | null; count: number }> = {};

    for (const check of checks) {
      let count = 0;
      let matchedSelector: string | null = null;

      for (const selector of check.selectors) {
        const c = $(selector).length;
        if (c > 0) {
          count = c;
          matchedSelector = selector;
          break;
        }
      }

      result[check.name] = {
        confidence: Math.min(count / check.expectedMin, 1),
        matchedSelector,
        count,
      };
    }

    return result;
  }

  /** Validate and normalize a URL string. */
  private normalizeUrl(raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    try {
      const url = new URL(raw);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
      return url.href;
    } catch {
      return undefined;
    }
  }

  /** Normalize category strings — dedupe, trim, filter empties. */
  private normalizeCategories(raw: string[], defaultCategory: string): string[] {
    const cleaned = raw
      .map((c) => c.trim())
      .filter((c) => c.length > 0 && c.length < 100);
    const unique = [...new Set(cleaned)];
    return unique.length > 0 ? unique : [defaultCategory];
  }

  async extractLeads(): Promise<LeadCandidate[]> {
    return [];
  }

  override async run(): Promise<CrawlResult> {
    const errors: string[] = [];
    const structuredErrors: StructuredCrawlError[] = [];
    const candidates: LeadCandidate[] = [];
    let pagesScraped = 0;
    let browser: Browser | undefined;

    try {
      browser = await chromium.launch({ headless: true });

      for (const directory of DIRECTORIES) {
        const log = logger.child({ directory: directory.name });

        for (let page = 1; page <= MAX_PAGES_PER_DIRECTORY; page++) {
          try {
            await this.sleep(this.currentRateLimitMs);
            const url = directory.pageUrlBuilder(directory.baseUrl, page, directory.paginationParam);

            log.info({ url, page }, 'Scraping CPG directory page');

            const context = await browser.newContext({ userAgent: this.getNextUserAgent() });
            const browserPage = await context.newPage();

            await browserPage.route('**/*', (route) => {
              const type = route.request().resourceType();
              if (['image', 'media', 'font'].includes(type)) {
                void route.abort();
              } else {
                void route.continue();
              }
            });

            let pageFoundItems = 0;
            try {
              const response = await browserPage.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: 25_000,
              });

              if (!response || response.status() >= 400) {
                const status = response?.status() ?? 0;
                throw new Error(`HTTP ${status} received for ${url}`);
              }

              const { html } = await this.captureRenderedDOM(browserPage, { postLoadDelayMs: 1500 });
              const $ = cheerio.load(html);

              const confidence = this.measureCardConfidence($, [
                { name: 'card', selectors: directory.selectors.card, expectedMin: 3 },
              ]);

              const cardConfidence = confidence['card'];

              if (cardConfidence.confidence < 0.3 || cardConfidence.count === 0) {
                log.info(
                  { page, matchedSelector: cardConfidence.matchedSelector, count: cardConfidence.count },
                  'No cards found — likely last page or layout change, stopping pagination',
                );
                await browserPage.close();
                await context.close();
                break;
              }

              const activeCardSelector = cardConfidence.matchedSelector ?? directory.selectors.card[0];

              $(activeCardSelector).each((_i, el) => {
                const nameEl = this.resolveSelector($, el, directory.selectors.name);
                const name = nameEl.text().trim();

                const websiteEl = this.resolveSelector($, el, directory.selectors.website);
                const websiteUrl = this.normalizeUrl(websiteEl.attr('href'));

                const categoryEls = directory.selectors.category.flatMap((sel) =>
                  $(el).find(sel).map((_j, c) => $(c).text().trim()).get(),
                );
                const categoryText = this.normalizeCategories(categoryEls, directory.defaultCategory);

                if (!name || name.length < 2 || name.length > 200) return;
                const lower = name.toLowerCase();
                if (['loading', 'error', 'unknown', 'n/a', 'null'].includes(lower)) return;

                candidates.push({
                  companyName: name,
                  websiteUrl,
                  categories: categoryText,
                  rawMetadata: {
                    source: directory.name,
                    directory: directory.baseUrl,
                    page,
                    matchedCardSelector: activeCardSelector,
                  },
                });
                pageFoundItems++;
              });

              pagesScraped++;
              this.adjustRateLimit('success');
              log.info(
                { page, found: pageFoundItems, totalSoFar: candidates.length, matchedSelector: activeCardSelector },
                'Directory page scraped',
              );

              if (pageFoundItems === 0) {
                log.info({ page }, 'Empty page — stopping pagination');
                await browserPage.close();
                await context.close();
                break;
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              const errorCode = classifyError(msg);
              structuredErrors.push({
                code: errorCode,
                domain: new URL(directory.baseUrl).hostname,
                message: msg,
                retryable: [CrawlErrorCode.TIMEOUT, CrawlErrorCode.NETWORK_ERROR].includes(errorCode),
                timestamp: new Date().toISOString(),
              });
              errors.push(`${directory.name}:page${page}: ${msg}`);
              this.adjustRateLimit('bot_blocked');
              await browserPage.close();
              await context.close();
              break;
            }

            await browserPage.close();
            await context.close();
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`${directory.name}:page${page}: ${msg}`);
            break;
          }
        }
      }
    } finally {
      await browser?.close();
    }

    if (candidates.length > 0) {
      await db.insert(agentOutputs).values({
        agentType: this.crawlerType,
        outputData: candidates as unknown,
      });
      logger.info({ count: candidates.length }, '[CPGDirectoryCrawler] Candidates persisted to agent_outputs');
    }

    return {
      crawlerType: this.crawlerType,
      recordsFound: candidates.length,
      newRecordsFound: candidates.length,
      pagesScraped,
      errors,
      structuredErrors,
    };
  }
}