import { chromium, type Browser } from 'playwright';
import * as cheerio from 'cheerio';
import { logger } from '@/lib/logger.js';
import { db } from '@/db/index.js';
import { agentOutputs } from '@/db/schema.js';
import { BaseLeadCrawler, type LeadCandidate } from './base-lead-crawler.js';
import { CrawlErrorCode, classifyError, type StructuredCrawlError } from '@/lib/crawler-errors.js';
import type { CrawlResult } from './base-crawler.js';

// Faire's brand browse — public, no auth required.
// Categories map to NCL's target product types.
const FAIRE_CATEGORY_PATHS = [
  { path: '/brand?category=FOOD_AND_DRINK',     category: 'food_beverage' },
  { path: '/brand?category=HEALTH_AND_WELLNESS', category: 'supplements' },
  { path: '/brand?category=BEAUTY',              category: 'cosmetics_personal_care' },
  { path: '/brand?category=HOME',                category: 'home_goods' },
  { path: '/brand?category=TOYS',                category: 'toys_games' },
];

const BASE_URL = 'https://www.faire.com';
const MAX_SCROLL_ROUNDS = 5; // number of infinite-scroll triggers per category

export class FaireCrawler extends BaseLeadCrawler {
  readonly crawlerType = 'faire';

  protected override readonly rateLimitMs = 3000;

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

      for (const { path, category } of FAIRE_CATEGORY_PATHS) {
        const url = `${BASE_URL}${path}`;
        const log = logger.child({ crawlerType: this.crawlerType, category, url });

        try {
          await this.sleep(this.currentRateLimitMs);

          const context = await browser.newContext({
            userAgent: this.getNextUserAgent(),
            viewport: { width: 1280, height: 900 },
          });
          const page = await context.newPage();

          // Block heavy assets to speed up loading
          await page.route('**/*', (route) => {
            const type = route.request().resourceType();
            if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
              void route.abort();
            } else {
              void route.continue();
            }
          });

          try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

            // Faire uses infinite scroll — trigger a few scroll rounds
            for (let scroll = 0; scroll < MAX_SCROLL_ROUNDS; scroll++) {
              await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
              await this.sleep(1500);
            }

            const { html } = await this.captureRenderedDOM(page, { postLoadDelayMs: 1000 });
            const $ = cheerio.load(html);

            // Faire renders brand cards with varied class patterns; try multiple selectors
            const cardSelector = [
              '[class*="BrandCard"]',
              '[class*="brand-card"]',
              '[data-testid*="brand"]',
              '[class*="BrandTile"]',
              '[class*="brand-tile"]',
              'article[class*="brand"]',
            ].join(', ');

            const confidence = this.measureSelectorConfidence($, [
              { name: 'card', selector: cardSelector, expectedMin: 5 },
            ]);

            if (confidence['card'].confidence < 0.2) {
              log.warn({ url }, 'No Faire brand cards found — layout may have changed');
              structuredErrors.push({
                code: CrawlErrorCode.SELECTOR_MISMATCH,
                domain: 'faire.com',
                category,
                message: `No brand cards found for category ${category}`,
                retryable: false,
                timestamp: new Date().toISOString(),
              });
              await page.close();
              await context.close();
              continue;
            }

            let found = 0;
            $(cardSelector).each((_i, el) => {
              const name = $(el).find('h2, h3, [class*="name"], [class*="Name"], strong').first().text().trim();
              const websiteEl = $(el).find('a[href^="/brand/"], a[href*="faire.com/brand/"]').first();
              const faireHref = websiteEl.attr('href');
              const externalWebsite = $(el).find('a[href^="http"]:not([href*="faire.com"])').first().attr('href');

              if (!name || name.length < 2) return;

              candidates.push({
                companyName: name,
                websiteUrl: externalWebsite ?? (faireHref ? `${BASE_URL}${faireHref}` : undefined),
                categories: [category],
                rawMetadata: {
                  source: 'faire',
                  fairePath: faireHref,
                  crawledUrl: url,
                },
              });
              found++;
            });

            pagesScraped++;
            this.adjustRateLimit('success');
            log.info({ found, totalSoFar: candidates.length }, 'Faire category scraped');
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const code = classifyError(msg);
            structuredErrors.push({
              code,
              domain: 'faire.com',
              category,
              message: msg,
              retryable: [CrawlErrorCode.TIMEOUT, CrawlErrorCode.NETWORK_ERROR].includes(code),
              timestamp: new Date().toISOString(),
            });
            errors.push(`faire:${category}: ${msg}`);
            this.adjustRateLimit('bot_blocked');
          }

          await page.close();
          await context.close();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`faire:${category}: ${msg}`);
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
      logger.info({ count: candidates.length }, '[FaireCrawler] Candidates persisted to agent_outputs');
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
