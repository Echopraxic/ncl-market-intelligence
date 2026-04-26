import { chromium, type Browser } from 'playwright';
import * as cheerio from 'cheerio';
import { logger } from '@/lib/logger.js';
import { db } from '@/db/index.js';
import { agentOutputs } from '@/db/schema.js';
import { BaseLeadCrawler, type LeadCandidate } from './base-lead-crawler.js';
import { CrawlErrorCode, classifyError, type StructuredCrawlError } from '@/lib/crawler-errors.js';
import type { CrawlResult } from './base-crawler.js';

// Bulletin is a wholesale marketplace for independent and diverse-owned brands.
// Public brand directory — no auth required to browse.
const BULLETIN_CATEGORY_PATHS = [
  { path: '/marketplace/category/food-beverage',    category: 'food_beverage' },
  { path: '/marketplace/category/wellness',         category: 'supplements' },
  { path: '/marketplace/category/beauty-personal-care', category: 'cosmetics_personal_care' },
  { path: '/marketplace/category/home-lifestyle',   category: 'home_goods' },
  { path: '/marketplace',                           category: 'general' },
];

const BASE_URL = 'https://bulletin.co';
const MAX_PAGES = 8;

export class BulletinCrawler extends BaseLeadCrawler {
  readonly crawlerType = 'bulletin';

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

      for (const { path, category } of BULLETIN_CATEGORY_PATHS) {
        const log = logger.child({ crawlerType: this.crawlerType, category });

        for (let page = 1; page <= MAX_PAGES; page++) {
          const url = page === 1
            ? `${BASE_URL}${path}`
            : `${BASE_URL}${path}?page=${page}`;

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

              // Bulletin uses React; scroll once to trigger lazy loading
              await browserPage.evaluate('window.scrollTo(0, document.body.scrollHeight / 2)');
              await this.sleep(800);

              const { html } = await this.captureRenderedDOM(browserPage, { postLoadDelayMs: 1000 });
              const $ = cheerio.load(html);

              const cardSelector = [
                '[class*="VendorCard"]',
                '[class*="vendor-card"]',
                '[class*="BrandCard"]',
                '[class*="brand-card"]',
                '[class*="BrandTile"]',
                '[class*="SupplierCard"]',
                'article',
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
                const name = $(el).find('h2, h3, h4, [class*="name"], [class*="Name"], [class*="title"], strong').first().text().trim();
                const website = $(el).find('a[href^="http"]:not([href*="bulletin.co"])').first().attr('href');
                const bulletinHref = $(el).is('a') ? $(el).attr('href') : $(el).find('a[href^="/"]').first().attr('href');
                const categoryText = $(el)
                  .find('[class*="category"], [class*="tag"], [class*="badge"], [class*="label"]')
                  .map((_j, c) => $(c).text().trim())
                  .get()
                  .filter(Boolean);

                if (!name || name.length < 2 || seenNames.has(name.toLowerCase())) return;
                seenNames.add(name.toLowerCase());

                candidates.push({
                  companyName: name,
                  websiteUrl: website ?? (bulletinHref ? `${BASE_URL}${bulletinHref}` : undefined),
                  categories: categoryText.length > 0 ? categoryText : [category],
                  rawMetadata: {
                    source: 'bulletin',
                    crawledUrl: url,
                    page,
                  },
                });
                foundOnPage++;
              });

              pagesScraped++;
              this.adjustRateLimit('success');
              log.info({ page, found: foundOnPage, totalSoFar: candidates.length }, 'Bulletin page scraped');

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
                domain: 'bulletin.co',
                category,
                message: msg,
                retryable: [CrawlErrorCode.TIMEOUT, CrawlErrorCode.NETWORK_ERROR].includes(code),
                timestamp: new Date().toISOString(),
              });
              errors.push(`bulletin:${category}:page${page}: ${msg}`);
              this.adjustRateLimit('bot_blocked');
              await browserPage.close();
              await context.close();
              break;
            }

            await browserPage.close();
            await context.close();
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`bulletin:${category}:page${page}: ${msg}`);
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
      logger.info({ count: candidates.length }, '[BulletinCrawler] Candidates persisted to agent_outputs');
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
