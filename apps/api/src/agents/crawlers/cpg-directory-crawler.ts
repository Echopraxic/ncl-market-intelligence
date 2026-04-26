import { chromium, type Browser } from 'playwright';
import * as cheerio from 'cheerio';
import { logger } from '@/lib/logger.js';
import { db } from '@/db/index.js';
import { agentOutputs } from '@/db/schema.js';
import { BaseLeadCrawler, type LeadCandidate } from './base-lead-crawler.js';
import { CrawlErrorCode, classifyError, type StructuredCrawlError } from '@/lib/crawler-errors.js';
import type { CrawlResult } from './base-crawler.js';

const MAX_PAGES_PER_DIRECTORY = 10;

const DIRECTORIES = [
  {
    name: 'cpgd',
    baseUrl: 'https://cpgd.xyz',
    paginationParam: 'page',
    selectors: {
      card: '.brand-card, [class*="brand-card"], [class*="BrandCard"], article, .card',
      name: 'h2, h3, .brand-name, [class*="name"], [class*="title"]',
      website: 'a[href^="http"]:not([href*="cpgd.xyz"])',
      category: '.category, [class*="tag"], [class*="category"], [class*="type"]',
    },
  },
  {
    name: 'bevnet',
    baseUrl: 'https://www.bevnet.com/companies/',
    paginationParam: 'paged',
    selectors: {
      card: '.company-card, .listing-item, article',
      name: 'h2, h3, .company-name',
      website: 'a[href^="http"]:not([href*="bevnet.com"])',
      category: '.category, .tags span',
    },
  },
];

export class CPGDirectoryCrawler extends BaseLeadCrawler {
  readonly crawlerType = 'cpg-directory';

  protected override readonly rateLimitMs = 2500;

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
            await this.sleep(this.rateLimitMs);
            const url = page === 1
              ? directory.baseUrl
              : `${directory.baseUrl}?${directory.paginationParam}=${page}`;

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
              await browserPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
              const { html } = await this.captureRenderedDOM(browserPage, { postLoadDelayMs: 1500 });
              const $ = cheerio.load(html);

              const confidence = this.measureSelectorConfidence($, [
                { name: 'card', selector: directory.selectors.card, expectedMin: 5 },
              ]);

              if (confidence['card'].confidence < 0.3) {
                log.info({ page }, 'No cards found — likely last page or layout change, stopping pagination');
                await browserPage.close();
                await context.close();
                break;
              }

              $(directory.selectors.card).each((_i, el) => {
                const name = $(el).find(directory.selectors.name).first().text().trim();
                const websiteUrl = $(el).find(directory.selectors.website).first().attr('href');
                const categoryText = $(el).find(directory.selectors.category).map((_j, c) => $(c).text().trim()).get().filter(Boolean);

                if (!name || name.length < 2) return;

                candidates.push({
                  companyName: name,
                  websiteUrl: websiteUrl ?? undefined,
                  categories: categoryText.length > 0 ? categoryText : ['Consumer Packaged Goods'],
                  rawMetadata: { source: directory.name, directory: directory.baseUrl, page },
                });
                pageFoundItems++;
              });

              pagesScraped++;
              this.adjustRateLimit('success');
              log.info({ page, found: pageFoundItems, totalSoFar: candidates.length }, 'Directory page scraped');

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
