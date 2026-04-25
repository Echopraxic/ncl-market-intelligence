import { chromium, type Browser } from 'playwright';
import * as cheerio from 'cheerio';
import { logger } from '@/lib/logger.js';
import { BaseLeadCrawler, type LeadCandidate } from './base-lead-crawler.js';
import { CrawlErrorCode, classifyError, type StructuredCrawlError } from '@/lib/crawler-errors.js';
import type { CrawlResult } from './base-crawler.js';

const CATEGORIES = [
  { slug: 'toys-and-games',      label: 'Toys & Games' },
  { slug: 'health-and-fitness',  label: 'Health & Fitness' },
  { slug: 'food-and-beverage',   label: 'Food & Beverage' },
  { slug: 'home-and-garden',     label: 'Home & Garden' },
  { slug: 'pet',                 label: 'Pet' },
];

export class ProductHuntCrawler extends BaseLeadCrawler {
  readonly crawlerType = 'product-hunt';

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

      for (const category of CATEGORIES) {
        try {
          await this.sleep(this.rateLimitMs);
          const url = `https://www.producthunt.com/products?category=${category.slug}`;
          const log = logger.child({ category: category.slug, url });
          log.info('Scraping Product Hunt category');

          const context = await browser.newContext({ userAgent: this.getNextUserAgent() });
          const page = await context.newPage();

          await page.route('**/*', (route) => {
            const type = route.request().resourceType();
            if (['image', 'media', 'font'].includes(type)) {
              void route.abort();
            } else {
              void route.continue();
            }
          });

          try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
            const { html } = await this.captureRenderedDOM(page, { postLoadDelayMs: 2000 });
            const $ = cheerio.load(html);

            this.measureSelectorConfidence($, [
              { name: 'post-item', selector: '[data-test="post-item"], .styles_item__Dk_nz', expectedMin: 5 },
            ]);

            $('[data-test="post-item"], .styles_item__Dk_nz').each((_i, el) => {
              const name = $(el).find('.styles_title__Tf2To, h3').first().text().trim();
              const tagline = $(el).find('.styles_tagline__EuZ_S, p').first().text().trim();
              const linkEl = $(el).find('a[href*="producthunt.com/posts"]').first();
              const postUrl = linkEl.attr('href');
              const websiteLink = $(el).find('a[href^="http"]:not([href*="producthunt.com"])').first();
              const websiteUrl = websiteLink.attr('href');

              if (!name || name.length < 2) return;

              const candidate: LeadCandidate = {
                companyName: name,
                websiteUrl: websiteUrl ?? undefined,
                categories: [category.label],
                rawMetadata: { tagline, postUrl, source: 'product_hunt', category: category.slug },
              };
              candidates.push(candidate);
            });

            pagesScraped++;
            this.adjustRateLimit('success');
            log.info({ found: candidates.length }, 'Product Hunt category scraped');
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const errorCode = classifyError(msg);
            structuredErrors.push({
              code: errorCode,
              domain: 'producthunt.com',
              category: category.slug,
              message: msg,
              retryable: [CrawlErrorCode.TIMEOUT, CrawlErrorCode.NETWORK_ERROR].includes(errorCode),
              timestamp: new Date().toISOString(),
            });
            errors.push(`product-hunt:${category.slug}: ${msg}`);
            this.adjustRateLimit('bot_blocked');
          } finally {
            await page.close();
            await context.close();
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`product-hunt:${category.slug}: ${msg}`);
        }
      }
    } finally {
      await browser?.close();
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
