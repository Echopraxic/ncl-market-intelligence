import { chromium, type Browser, type Page } from 'playwright';
import * as cheerio from 'cheerio';
import pLimit from 'p-limit';
import { db } from '@/db/index.js';
import { euMarketSignals } from '@/db/schema.js';
import { logger } from '@/lib/logger.js';
import { eq, and, gte } from 'drizzle-orm';
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
  /** Amazon browse node ID (DE locale as canonical; other locales fall back gracefully) */
  browseNodeId: string;
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

const DOMAIN_CONFIGS: DomainConfig[] = [
  { domain: 'amazon.de',     countryCode: 'DE', currency: 'EUR', baseUrl: 'https://www.amazon.de' },
  { domain: 'amazon.fr',     countryCode: 'FR', currency: 'EUR', baseUrl: 'https://www.amazon.fr' },
  { domain: 'amazon.nl',     countryCode: 'NL', currency: 'EUR', baseUrl: 'https://www.amazon.nl' },
  { domain: 'amazon.ie',     countryCode: 'IE', currency: 'EUR', baseUrl: 'https://www.amazon.ie' },
  { domain: 'amazon.co.uk',  countryCode: 'GB', currency: 'GBP', baseUrl: 'https://www.amazon.co.uk' },
];

// Categories aligned with NCL's target segments (toys, CPG, wellness, home goods).
// Browse node IDs are DE locale; Amazon remaps them per locale via the URL.
const CATEGORIES: CategoryConfig[] = [
  { categoryName: 'Toys & Games',           browseNodeId: '12409153031', categoryPath: 'Toys & Games',           hasNewReleases: true },
  { categoryName: 'Home & Kitchen',          browseNodeId: '310842031',   categoryPath: 'Home & Kitchen',          hasNewReleases: true },
  { categoryName: 'Beauty',                  browseNodeId: '119614031',   categoryPath: 'Beauty',                  hasNewReleases: true },
  { categoryName: 'Health & Personal Care',  browseNodeId: '12408854031', categoryPath: 'Health & Personal Care',  hasNewReleases: true },
  { categoryName: 'Grocery',                 browseNodeId: '340834031',   categoryPath: 'Grocery',                 hasNewReleases: true },
  { categoryName: 'Baby Products',           browseNodeId: '1981001031',  categoryPath: 'Baby',                    hasNewReleases: true },
  { categoryName: 'Pet Supplies',            browseNodeId: '340852031',   categoryPath: 'Pet Supplies',            hasNewReleases: true },
  { categoryName: 'Sports & Outdoors',       browseNodeId: '16435121031', categoryPath: 'Sports & Outdoors',       hasNewReleases: true },
];

const SELECTORS: AmazonSelectors = {
  product:     '[data-asin]:not([data-asin=""])',
  rank:        '.zg-bdg-text, .a-size-small.a-color-secondary, .celwidget .a-size-small',
  title:       'h2 a span, .p13n-sc-truncate, [data-cy="title-recipe-title"] span',
  link:        'h2 a, a.a-link-normal[href*="/dp/"]',
  reviewCount: 'a[href*="reviews"] span, .a-size-small.a-color-secondary',
  rating:      '.a-icon-alt, span[aria-label*="stars"]',
  price:       '.a-price .a-offscreen, .p13n-sc-price, .a-price-whole',
  badge:       '.a-badge-text, .p13n-best-seller-badge',
};

// ---------------------------------------------------------------------------
// Crawler
// ---------------------------------------------------------------------------

export class AmazonEUCrawler extends BaseCrawler {
  readonly crawlerType = 'amazon-eu';

  private browser: Browser | undefined;
  private readonly maxPagesPerCategory = 2;   // top 50–100 products
  private readonly domainCooldownMs = 3_000;  // 3 s between same-domain requests

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
    const page = await this.createPage();
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

        const { html } = await this.captureRenderedDOM(page, {
          waitSelector: SELECTORS.product,
          postLoadDelayMs: 800,
        });

        const products = this.parseProducts(html, domainConfig, pageType);
        const $ = cheerio.load(html);
        const confidence = this.measureSelectorConfidence($, [
          { name: 'product', selector: SELECTORS.product, expectedMin: 20 },
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

  private async createPage(): Promise<Page> {
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

    // Anti-detection: hide automation indicators.
    // The callback runs inside the browser context (not Node), so window/navigator are valid there.
    await page.addInitScript(`
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
      delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
    `);

    return page;
  }

  private buildUrl(
    domainConfig: DomainConfig,
    category: CategoryConfig,
    pageType: PageType,
    pageNum: number,
  ): string {
    const basePath = pageType === 'bestsellers' ? 'gp/bestsellers' : 'gp/new-releases';
    let url = `${domainConfig.baseUrl}/${basePath}/${category.browseNodeId}`;
    url += pageNum > 1
      ? `?_encoding=UTF8&pg=${pageNum}&ajax=1`
      : '?_encoding=UTF8&ajax=1';
    return url;
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

    $(SELECTORS.product).each((_, el) => {
      const $el = $(el);
      const asin = $el.attr('data-asin');
      if (!asin) return;

      const rankText = $el.find(SELECTORS.rank).first().text().trim();
      const rankMatch = rankText.match(/#?(\d+)/);
      const rank = rankMatch ? parseInt(rankMatch[1], 10) : 0;

      const title = $el.find(SELECTORS.title).first().text().trim();
      if (!title || rank === 0) return;

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

    const signalCategory = `${category.categoryName} (${pageType})`;
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
