import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import * as cheerio from 'cheerio';
import pLimit from 'p-limit';
import { db } from '@/db/index.js';
import { euMarketSignals } from '@/db/schema.js';
import { logger } from '@/lib/logger.js';
import { eq, and, gte, sql } from 'drizzle-orm';
import { BaseCrawler, type CrawlResult } from './base-crawler.js';
import { CrawlErrorCode, StructuredCrawlError, classifyError } from '@/lib/crawler-errors.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AmazonDomain =
  | 'amazon.de'
  | 'amazon.fr'
  | 'amazon.nl'
  | 'amazon.ie'
  | 'amazon.co.uk';

type PageType = 'bestsellers' | 'new-releases';

type CategoryConfig = {
  categoryName: string;
  /** URL slug — consistent across all Amazon EU locales (Amazon 301s to locale equivalent) */
  urlSlug: string;
  categoryPath: string;
  hasNewReleases: boolean;
};

type DomainConfig = {
  domain: AmazonDomain;
  countryCode: string;
  currency: string;
  baseUrl: string;
};

type ParsedProduct = {
  asin: string;
  title: string;
  rank: number;
  reviewCount: number;
  rating?: number;
  price?: string;
  badge?: string;
  url: string;
  velocityScore: number;
};

type AmazonSelectors = {
  product: string;
  rank: string;
  title: string;
  link: string;
  reviewCount: string;
  rating: string;
  price: string;
  badge: string;
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Reduced to 3 highest-priority NCL markets. NL and IE share inventory with DE/FR
// and adding them multiplies page loads without proportional signal gain.
const DOMAIN_CONFIGS: DomainConfig[] = [
  { domain: 'amazon.de',    countryCode: 'DE', currency: 'EUR', baseUrl: 'https://www.amazon.de' },
  { domain: 'amazon.fr',    countryCode: 'FR', currency: 'EUR', baseUrl: 'https://www.amazon.fr' },
  { domain: 'amazon.co.uk', countryCode: 'GB', currency: 'GBP', baseUrl: 'https://www.amazon.co.uk' },
];

// URL slugs are consistent across all Amazon EU locales — Amazon 301-redirects
// english slugs to the locale-specific category page.
// categoryName uses NCL taxonomy slugs so signals join cleanly with the trend engine.
const CATEGORIES: CategoryConfig[] = [
  { categoryName: 'toys_games',              urlSlug: 'toys-games',           categoryPath: 'Toys & Games',           hasNewReleases: true  },
  { categoryName: 'cosmetics_personal_care', urlSlug: 'beauty',               categoryPath: 'Beauty',                  hasNewReleases: true  },
  { categoryName: 'supplements',             urlSlug: 'health-personal-care', categoryPath: 'Health & Personal Care',  hasNewReleases: true  },
  { categoryName: 'food_beverage',           urlSlug: 'grocery',              categoryPath: 'Grocery',                 hasNewReleases: false },
  { categoryName: 'home_goods',              urlSlug: 'home-garden',          categoryPath: 'Home & Kitchen',          hasNewReleases: false },
];

const SELECTORS: AmazonSelectors = {
  // Target the bestseller ordered list items directly.
  // [data-asin] alone is removed — it matches ads, sidebars, and carousels too,
  // which all have data-asin but no rank badge, causing rank=0 filtering to drop everything.
  product:     'ol#zg-ordered-list li, li.zg-item-immersion, div.zg-item-immersion, div[class*="zg-item"]',
  // Rank badge
  rank:        '.zg-bdg-text, span[class*="zg-bdg"], .zg-bdg-wrapper span',
  // Title — covers both grid and list layouts across locales
  title:       '.p13n-sc-line-clamp-2 a span, .p13n-sc-truncate-desktop-type2, h2 a span, .p13n-sc-truncate, [data-cy="title-recipe-title"] span',
  link:        'h2 a, .p13n-sc-line-clamp-2 a, a.a-link-normal[href*="/dp/"]',
  reviewCount: 'span[aria-label$=" ratings"], span[aria-label$=" Bewertungen"], span[aria-label$=" évaluations"], a[href*="reviews"] span',
  rating:      '.a-icon-star-small .a-icon-alt, .a-icon-alt, span[aria-label*="stars"], span[aria-label*="Sterne"]',
  price:       '.p13n-sc-price, .a-price .a-offscreen, .a-price-whole',
  badge:       '.a-badge-text, .p13n-best-seller-badge, .a-badge-label',
};

// ---------------------------------------------------------------------------
// Crawler
// ---------------------------------------------------------------------------

export class AmazonEUCrawler extends BaseCrawler {
  readonly crawlerType = 'amazon-eu';

  private browser: Browser | undefined;
  private readonly maxPagesPerCategory = 1;   // top 50 products; page 2 rarely survives bot detection
  private readonly domainCooldownMs = 1_500;  // 1.5 s between same-domain requests

  async run(): Promise<CrawlResult> {
    const errors: string[] = [];
    const structuredErrors: StructuredCrawlError[] = [];
    let recordsFound = 0;
    let newRecordsFound = 0;
    let pagesScraped = 0;

    try {
      this.browser = await chromium.launch({
        headless: true,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--disable-web-security',
          '--disable-features=IsolateOrigins,site-per-process',
          '--no-sandbox',
          '--disable-setuid-sandbox',
        ],
      });

      const domainLimit = pLimit(2);
      await Promise.all(
        DOMAIN_CONFIGS.map((domainConfig) =>
          domainLimit(() =>
            this.scrapeDomain(domainConfig).then((result) => {
              recordsFound += result.recordsFound;
              newRecordsFound += result.newRecordsFound;
              pagesScraped += result.pagesScraped;
              errors.push(...result.errors);
              structuredErrors.push(...result.structuredErrors);
            }),
          ),
        ),
      );
    } finally {
      await this.browser?.close();
    }

    return { crawlerType: this.crawlerType, recordsFound, newRecordsFound, pagesScraped, errors, structuredErrors };
  }

  private async scrapeDomain(domainConfig: DomainConfig): Promise<{ recordsFound: number; newRecordsFound: number; pagesScraped: number; errors: string[]; structuredErrors: StructuredCrawlError[] }> {
    const errors: string[] = [];
    const structuredErrors: StructuredCrawlError[] = [];
    let recordsFound = 0;
    let newRecordsFound = 0;
    let pagesScraped = 0;
    let domainBlocked = false;

    for (const category of CATEGORIES) {
      if (domainBlocked) break;

      try {
        const bestsellerResult = await this.scrapeCategoryPage(domainConfig, category, 'bestsellers');
        if (bestsellerResult.botBlocked) {
          logger.warn({ domain: domainConfig.domain }, 'Bot detection triggered — skipping domain');
          const botError: StructuredCrawlError = {
            code: CrawlErrorCode.BOT_BLOCKED,
            domain: domainConfig.domain,
            category: category.categoryName,
            message: `Bot detection triggered on ${domainConfig.domain}`,
            retryable: false,
            timestamp: new Date().toISOString(),
          };
          structuredErrors.push(botError);
          errors.push(`${domainConfig.domain}: bot detection triggered`);
          domainBlocked = true;
          break;
        }
        recordsFound += bestsellerResult.count;
        newRecordsFound += bestsellerResult.newRecordsFound ?? 0;
        pagesScraped += bestsellerResult.pagesScraped;

        if (category.hasNewReleases && !domainBlocked) {
          await this.sleep(this.domainCooldownMs);
          const newReleasesResult = await this.scrapeCategoryPage(domainConfig, category, 'new-releases');
          if (newReleasesResult.botBlocked) {
            domainBlocked = true;
            break;
          }
          recordsFound += newReleasesResult.count;
          newRecordsFound += newReleasesResult.newRecordsFound ?? 0;
          pagesScraped += newReleasesResult.pagesScraped;
        }

        await this.sleep(2000);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(
          { domain: domainConfig.domain, category: category.categoryName, error: msg },
          'Failed to scrape Amazon category',
        );
        const errorCode = classifyError(msg);
        const structError: StructuredCrawlError = {
          code: errorCode,
          domain: domainConfig.domain,
          category: category.categoryName,
          message: msg,
          retryable: true,
          timestamp: new Date().toISOString(),
        };
        structuredErrors.push(structError);
        errors.push(`${domainConfig.domain}-${category.categoryName}: ${msg}`);
        await this.sleep(10_000);
      }
    }

    return { recordsFound, newRecordsFound, pagesScraped, errors, structuredErrors };
  }

  // -------------------------------------------------------------------------
  // Page scraping
  // -------------------------------------------------------------------------

  private async scrapeCategoryPage(
    domainConfig: DomainConfig,
    category: CategoryConfig,
    pageType: PageType,
  ): Promise<{ count: number; botBlocked: boolean; newRecordsFound: number; pagesScraped: number }> {
    const log = logger.child({ domain: domainConfig.domain, category: category.categoryName, pageType });
    const { page, context } = await this.createPage();
    const allProducts: ParsedProduct[] = [];
    let pagesScraped = 0;

    try {
      for (let pageNum = 1; pageNum <= this.maxPagesPerCategory; pageNum++) {
        const url = this.buildUrl(domainConfig, category, pageType, pageNum);
        log.info({ url, pageNum }, 'Navigating to Amazon page');

        await this.withRetry(
          () => page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 }),
          `navigate:${domainConfig.domain}:${category.categoryName}:${pageNum}`,
          2,
        );
        pagesScraped++;

        // Detect bot-block pages (robot check, sign-in redirect, error pages)
        const currentUrl = page.url();
        const pageTitle = await page.title().catch(() => '');
        if (this.isBotBlocked(currentUrl, pageTitle)) {
          log.warn({ currentUrl, pageTitle }, 'Amazon bot detection detected');
          return { count: 0, botBlocked: true, newRecordsFound: 0, pagesScraped };
        }

        // Wait for the bestseller ordered list specifically — not the broad product
        // selector, which would match [data-asin] ads in the initial HTML immediately.
        const { html } = await this.captureRenderedDOM(page, {
          waitSelector: 'ol#zg-ordered-list, ol.zg-ordered-list, li.zg-item-immersion',
          postLoadDelayMs: 2000,
        });

        const products = this.parseProducts(html, domainConfig, pageType);
        const $ = cheerio.load(html);
        const confidence = this.measureSelectorConfidence($, [
          // Use the ordered list selector for confidence — the broad [data-asin] fallback
          // in SELECTORS.product would always report high confidence even on non-product pages.
          { name: 'product', selector: 'ol#zg-ordered-list li, li.zg-item-immersion', expectedMin: 20 },
        ]);

        if (confidence.product.confidence < 0.5) {
          const selectorError: StructuredCrawlError = {
            code: CrawlErrorCode.SELECTOR_MISMATCH,
            domain: domainConfig.domain,
            category: category.categoryName,
            message: `Low selector confidence for products: ${confidence.product.found}/${confidence.product.expectedMin}`,
            retryable: true,
            timestamp: new Date().toISOString(),
          };
          log.warn({ confidence: confidence.product }, 'Selector mismatch warning');
        }

        if (products.length === 0) {
          log.info({ pageNum }, 'No products found — stopping pagination');
          break;
        }

        log.info({ pageNum, count: products.length }, 'Parsed products');
        allProducts.push(...products);

        const hasNext = await this.hasNextPage(page);
        if (!hasNext) break;

        await this.sleep(this.domainCooldownMs);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ error: msg }, 'Category scrape failed — partial results may be saved');
      throw err;
    } finally {
      await page.close();
      await context.close();  // fix: context was previously never closed → zombie contexts accumulated
    }

    const { inserted, newRecords } = await this.insertCategorySignal(domainConfig, category, pageType, allProducts);
    log.info({ inserted, newRecords }, 'Category signal upserted');
    return { count: inserted, botBlocked: false, newRecordsFound: newRecords, pagesScraped };
  }

  private isBotBlocked(url: string, title: string): boolean {
    const titleLower = title.toLowerCase();
    return (
      url.includes('/ap/signin') ||
      url.includes('/errors/') ||
      url.includes('captcha') ||
      titleLower.includes('robot check') ||
      titleLower.includes('verify') ||
      titleLower.includes('security check') ||
      titleLower.includes('access denied') ||
      titleLower.includes('not found') && url.includes('signin')
    );
  }

  // -------------------------------------------------------------------------
  // Browser / page setup
  // -------------------------------------------------------------------------

  private async createPage(): Promise<{ page: Page; context: BrowserContext }> {
    if (!this.browser) throw new Error('Browser not initialized');

    const context = await this.browser.newContext({
      userAgent: this.getNextUserAgent(),
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
      timezoneId: 'Europe/London',
    });

    const page = await context.newPage();

    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'media', 'font'].includes(type)) {
        void route.abort();
      } else {
        void route.continue();
      }
    });

    // Anti-detection: hide automation indicators (runs in browser context, not Node)
    await page.addInitScript(`
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
      delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
    `);

    return { page, context };
  }

  private buildUrl(
    domainConfig: DomainConfig,
    category: CategoryConfig,
    pageType: PageType,
    pageNum: number,
  ): string {
    // Use URL slug (not browse node ID) — slugs are cross-locale; Amazon 301-redirects to
    // the locale-specific category. No ajax=1: that parameter triggers a partial XHR
    // response format incompatible with the standard product grid Cheerio parses.
    const basePath = pageType === 'bestsellers' ? 'gp/bestsellers' : 'gp/new-releases';
    const base = `${domainConfig.baseUrl}/${basePath}/${category.urlSlug}`;
    return pageNum > 1 ? `${base}?ie=UTF8&pg=${pageNum}` : base;
  }

  // -------------------------------------------------------------------------
  // HTML parsing
  // -------------------------------------------------------------------------

  private parseProducts(
    html: string,
    domainConfig: DomainConfig,
    pageType: PageType,
  ): ParsedProduct[] {
    const $ = cheerio.load(html);
    const results: ParsedProduct[] = [];
    const seenAsins = new Set<string>();

    $(SELECTORS.product).each((itemIndex, el) => {
      const $el = $(el);
      // ASIN may be on the li itself or on a child container
      const asin = $el.attr('data-asin') ?? $el.find('[data-asin]').first().attr('data-asin');
      if (!asin || seenAsins.has(asin)) return;
      seenAsins.add(asin);

      const title = $el.find(SELECTORS.title).first().text().trim();
      if (!title) return;

      // Rank: try the badge text first; fall back to DOM position (1-indexed).
      // The rank badge frequently fails to render in headless mode — position is a
      // reliable proxy since ol#zg-ordered-list is a true ordered list.
      const rankText = $el.find(SELECTORS.rank).first().text().trim();
      const rankMatch = rankText.match(/#?(\d+)/);
      const rank = rankMatch ? parseInt(rankMatch[1], 10) : (itemIndex + 1);

      const relativeLink = $el.find(SELECTORS.link).first().attr('href') ?? '';
      const url = relativeLink.startsWith('http')
        ? relativeLink
        : `${domainConfig.baseUrl}${relativeLink}`;

      const reviewText = $el.find(SELECTORS.reviewCount).text();
      const reviewMatch =
        reviewText.match(/([\d.,]+)\s*ratings/i) ||
        reviewText.match(/([\d.,]+)\s*Bewertungen/i) ||
        reviewText.match(/([\d.,]+)\s*évaluations/i) ||
        reviewText.match(/([\d.,]+)\s*beoordelingen/i);
      const reviewCount = reviewMatch ? this.parseNumber(reviewMatch[1]) : 0;

      const ratingText =
        $el.find(SELECTORS.rating).attr('aria-label') ??
        $el.find(SELECTORS.rating).text();
      const ratingMatch =
        ratingText.match(/(\d+[.,]?\d*)\s*out of\s*5/i) ||
        ratingText.match(/(\d+[.,]?\d*)\s*von\s*5/i) ||
        ratingText.match(/(\d+[.,]?\d*)\s*sur\s*5/i) ||
        ratingText.match(/(\d+[.,]?\d*)\s*van\s*5/i);
      const rating = ratingMatch ? parseFloat(ratingMatch[1].replace(',', '.')) : undefined;

      const priceText = $el.find(SELECTORS.price).first().text().trim();
      const badge = $el.find(SELECTORS.badge).first().text().trim() || undefined;

      results.push({
        asin,
        title,
        rank,
        reviewCount,
        rating,
        price: priceText || undefined,
        badge,
        url,
        velocityScore: this.calculateVelocityScore({ rank, reviewCount, rating, pageType }),
      });
    });

    return results;
  }

  private async hasNextPage(page: Page): Promise<boolean> {
    try {
      const nextBtn = page.locator('.a-pagination .a-last:not(.a-disabled), .zg-pagination a[href*="pg="]').first();
      return await nextBtn.isVisible({ timeout: 2000 });
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Database write
  //
  // One signal row per (country, category, pageType) per calendar day.
  // signalValue = number of products captured (market depth indicator).
  // rawData holds the full ranked product list for scoring/analysis.
  // -------------------------------------------------------------------------

  private async insertCategorySignal(
    domainConfig: DomainConfig,
    category: CategoryConfig,
    pageType: PageType,
    products: ParsedProduct[],
  ): Promise<{ inserted: number; newRecords: number }> {
    if (products.length === 0) return { inserted: 0, newRecords: 0 };

    const signalCategory = category.categoryName;  // NCL taxonomy slug
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const existing = await db
      .select({ id: euMarketSignals.id })
      .from(euMarketSignals)
      .where(
        and(
          eq(euMarketSignals.source, 'amazon_eu'),
          eq(euMarketSignals.countryCode, domainConfig.countryCode),
          eq(euMarketSignals.category, signalCategory),
          gte(euMarketSignals.capturedAt, todayStart),
          sql`${euMarketSignals.rawData}->>'pageType' = ${pageType}`,
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      logger.debug(
        { countryCode: domainConfig.countryCode, signalCategory },
        'Amazon EU signal already captured today — skipping',
      );
      return { inserted: 0, newRecords: 0 };
    }

    await db.insert(euMarketSignals).values({
      source: 'amazon_eu',
      countryCode: domainConfig.countryCode,
      category: signalCategory,
      signalType: 'demand',
      signalValue: products.length,
      rawData: {
        pageType,
        currency: domainConfig.currency,
        domain: domainConfig.domain,
        categoryPath: category.categoryPath,
        topProducts: products.map((p) => ({
          asin: p.asin,
          title: p.title,
          rank: p.rank,
          reviewCount: p.reviewCount,
          rating: p.rating,
          price: p.price,
          badge: p.badge,
          url: p.url,
          velocityScore: p.velocityScore,
        })),
      },
    });

    return { inserted: products.length, newRecords: products.length };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private calculateVelocityScore(product: {
    rank: number;
    reviewCount: number;
    rating?: number;
    pageType: PageType;
  }): number {
    let score = 0;
    if (product.pageType === 'new-releases') {
      score += Math.max(0, 100 - product.rank);
      score += Math.min(product.reviewCount / 10, 50);
    } else {
      score += Math.max(0, 50 - product.rank / 2);
      score += Math.min(product.reviewCount / 50, 30);
    }
    if (product.rating && product.rating >= 4.5) score += 10;
    return Math.round(score);
  }

  private parseNumber(str: string): number {
    return parseInt(str.replace(/[.,]/g, ''), 10) || 0;
  }
}
