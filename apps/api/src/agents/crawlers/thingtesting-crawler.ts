import { chromium, type Browser } from 'playwright';
import * as cheerio from 'cheerio';
import { logger } from '@/lib/logger.js';
import { db } from '@/db/index.js';
import { agentOutputs } from '@/db/schema.js';
import { BaseLeadCrawler, type LeadCandidate } from './base-lead-crawler.js';
import { CrawlErrorCode, classifyError, type StructuredCrawlError } from '@/lib/crawler-errors.js';
import type { CrawlResult } from './base-crawler.js';

// ThingTesting is a DTC brand review + discovery platform.
// Public brand listings require no auth; filtered by category.
const THINGTESTING_CATEGORY_URLS = [
  { url: 'https://thingtesting.com/brands?category=food-beverage',    category: 'food_beverage' },
  { url: 'https://thingtesting.com/brands?category=health-wellness',  category: 'supplements' },
  { url: 'https://thingtesting.com/brands?category=beauty',           category: 'cosmetics_personal_care' },
  { url: 'https://thingtesting.com/brands?category=home',             category: 'home_goods' },
  { url: 'https://thingtesting.com/brands',                           category: 'general' },
];

const MAX_PAGES = 8;

export class ThingTestingCrawler extends BaseLeadCrawler {
  readonly crawlerType = 'thingtesting';

  protected override readonly rateLimitMs = 2500;

  async extractLeads(): Promise<LeadCandidate[]> {
    return [];
  }

  override async run(): Promise<CrawlResult> {
    const errors: string[] = [];
    const structuredErrors: StructuredCrawlError[] = [];
    const candidates: LeadCandidate[] = [];
    const seenNames = new Set<string>();
    let pagesScraped = 0;
    let browser: Browser | undefined;

    try {
      browser = await chromium.launch({ headless: true });

      for (const { url: baseUrl, category } of THINGTESTING_CATEGORY_URLS) {
        const log = logger.child({ crawlerType: this.crawlerType, category });

        for (let page = 1; page <= MAX_PAGES; page++) {
          const url = page === 1 ? baseUrl : `${baseUrl}&page=${page}`;

          try {
            await this.sleep(this.currentRateLimitMs);

            const context = await browser.newContext({
              userAgent: this.getNextUserAgent(),
              viewport: { width: 1280, height: 900 },
            });
            const browserPage = await context.newPage();

            await browserPage.route('**/*', (route) => {
              const type = route.request().resourceType();
              if (['image', 'media', 'font'].includes(type)) {
                void route.abort();
              } else {
                void route.continue();
              }
            });

            let foundOnPage = 0;
            try {
              await browserPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
              const { html } = await this.captureRenderedDOM(browserPage, { postLoadDelayMs: 1200 });
              const $ = cheerio.load(html);

              const cardSelector = [
                '[class*="BrandCard"]',
                '[class*="brand-card"]',
                '[class*="brand-item"]',
                '[class*="BrandListItem"]',
                'article',
                '.grid > div > a',
              ].join(', ');

              const confidence = this.measureSelectorConfidence($, [
                { name: 'card', selector: cardSelector, expectedMin: 5 },
              ]);

              if (confidence['card'].confidence < 0.2) {
                log.info({ page }, 'No brand cards — likely last page, stopping');
                await browserPage.close();
                await context.close();
                break;
              }

              $(cardSelector).each((_i, el) => {
                const name = $(el).find('h2, h3, h4, [class*="name"], [class*="Name"], strong').first().text().trim();
                const website = $(el).find('a[href^="http"]:not([href*="thingtesting.com"])').first().attr('href');
                const thingTestingHref = $(el).is('a') ? $(el).attr('href') : $(el).find('a[href^="/"]').first().attr('href');
                const categoryText = $(el).find('[class*="category"], [class*="tag"], [class*="badge"]').map((_j, c) => $(c).text().trim()).get().filter(Boolean);

                if (!name || name.length < 2 || seenNames.has(name.toLowerCase())) return;
                seenNames.add(name.toLowerCase());

                candidates.push({
                  companyName: name,
                  websiteUrl: website ?? (thingTestingHref ? `https://thingtesting.com${thingTestingHref}` : undefined),
                  categories: categoryText.length > 0 ? categoryText : [category],
                  rawMetadata: {
                    source: 'thingtesting',
                    crawledUrl: url,
                    page,
                  },
                });
                foundOnPage++;
              });

              pagesScraped++;
              this.adjustRateLimit('success');
              log.info({ page, found: foundOnPage, totalSoFar: candidates.length }, 'ThingTesting page scraped');

              if (foundOnPage === 0) {
                await browserPage.close();
                await context.close();
                break;
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              const code = classifyError(msg);
              structuredErrors.push({
                code,
                domain: 'thingtesting.com',
                category,
                message: msg,
                retryable: [CrawlErrorCode.TIMEOUT, CrawlErrorCode.NETWORK_ERROR].includes(code),
                timestamp: new Date().toISOString(),
              });
              errors.push(`thingtesting:${category}:page${page}: ${msg}`);
              this.adjustRateLimit('bot_blocked');
              await browserPage.close();
              await context.close();
              break;
            }

            await browserPage.close();
            await context.close();
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`thingtesting:${category}:page${page}: ${msg}`);
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
      logger.info({ count: candidates.length }, '[ThingTestingCrawler] Candidates persisted to agent_outputs');
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
