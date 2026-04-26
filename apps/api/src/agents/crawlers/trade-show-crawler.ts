import { chromium, type Browser, type Page } from 'playwright';
import * as cheerio from 'cheerio';
import { db } from '@/db/index.js';
import { tradeShows, tradeShowExhibitors } from '@/db/schema.js';
import { logger } from '@/lib/logger.js';
import { eq } from 'drizzle-orm';
import { BaseCrawler, type CrawlResult } from './base-crawler.js';
import { CrawlErrorCode, StructuredCrawlError, classifyError } from '@/lib/crawler-errors.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ExhibitorScrapeStrategy =
  | 'playwright-cards'   // JS-rendered cards/grid (most show sites)
  | 'playwright-table'   // HTML table rendered via JS
  | 'none';              // No public exhibitor directory; seed metadata only

type ShowSelectors = {
  /** CSS selector that matches one element per exhibitor */
  card: string;
  /** Relative selector inside card for exhibitor name */
  name: string;
  /** Relative selector inside card for website link (optional) */
  website?: string;
  /** Relative selector inside card for category tags (optional) */
  category?: string;
  /** Relative selector inside card for booth number (optional) */
  booth?: string;
  /** Selector to click to load more results, if paginated (optional) */
  loadMoreButton?: string;
};

type ShowConfig = {
  // --- Static metadata seeded into trade_shows table ---
  name: string;
  location: string;
  countryCode: string;
  startDate: Date;
  endDate: Date;
  categories: string[];
  websiteUrl: string;

  // --- Scrape config ---
  exhibitorPageUrl: string;
  strategy: ExhibitorScrapeStrategy;
  selectors?: ShowSelectors;
  /** Max pages to walk when paginating — prevents runaway scrapes */
  maxPages?: number;
  /** Extra ms to wait after page load before attempting extraction */
  waitAfterLoadMs?: number;
};

// ---------------------------------------------------------------------------
// Seed data — one entry per show
//
// Dates reflect the next known or estimated edition as of March 2026.
// Exhibitor selectors are best-effort and will need tuning when a show
// redesigns its directory. The normalization agent handles category filtering.
// ---------------------------------------------------------------------------

const SHOW_CONFIGS: ShowConfig[] = [
  {
    name: 'Toy Fair New York (NYTF)',
    location: 'Javits Center, New York, NY',
    countryCode: 'US',
    // Toy Fair moved to October in 2024. Next edition: October 2026.
    startDate: new Date('2026-10-05'),
    endDate: new Date('2026-10-08'),
    categories: ['Toys', 'Games', 'Youth Electronics', 'Infant & Preschool', 'Outdoor & Sports'],
    websiteUrl: 'https://www.toyfair.com',
    exhibitorPageUrl: 'https://www.toyfair.com/exhibitors',
    strategy: 'playwright-cards',
    selectors: {
      card: '[class*="exhibitor-card"], [class*="ExhibitorCard"], .exhibitor-item, [data-exhibitor]',
      name: '[class*="company-name"], [class*="CompanyName"], h3, h4',
      website: 'a[href*="http"]:not([href*="toyfair"])',
      category: '[class*="category"], [class*="product-category"]',
      booth: '[class*="booth"], [class*="Booth"]',
      loadMoreButton: 'button[class*="load-more"], button[class*="LoadMore"], [aria-label*="load more"]',
    },
    maxPages: 20,
    waitAfterLoadMs: 3000,
  },
  {
    name: 'ASD Market Week',
    location: 'Las Vegas Convention Center, Las Vegas, NV',
    countryCode: 'US',
    // ASD runs twice yearly (March & August). Next August edition:
    startDate: new Date('2026-08-02'),
    endDate: new Date('2026-08-05'),
    categories: [
      'Consumer Packaged Goods', 'Toys & Games', 'Health & Beauty',
      'Food & Beverage', 'Home & Garden', 'General Merchandise',
    ],
    websiteUrl: 'https://www.asdmarketweek.com',
    // asdmarketweek.com has a Cloudflare DNS misconfiguration (error 1000) — entire domain down.
    // Seed metadata only until the site is restored.
    exhibitorPageUrl: 'https://www.asdmarketweek.com/exhibitors',
    strategy: 'none',
    waitAfterLoadMs: 3000,
  },
  {
    name: 'SIAL Paris',
    location: 'Paris Nord Villepinte, Paris',
    countryCode: 'FR',
    // SIAL is biennial (even years). Next edition: October 2026.
    startDate: new Date('2026-10-17'),
    endDate: new Date('2026-10-21'),
    categories: ['Food & Beverage', 'Specialty Foods', 'Organic', 'Dairy', 'Snacks & Confectionery'],
    websiteUrl: 'https://www.sialparis.com',
    // sialparis.com blocks all scraper paths with Cloudflare (403) and the exhibitor
    // directory is not publicly accessible without registration. Seed metadata only.
    exhibitorPageUrl: 'https://www.sialparis.com/en/exhibitors',
    strategy: 'none',
    waitAfterLoadMs: 4000,
  },
  {
    name: 'Canton Fair (China Import & Export Fair)',
    location: 'China Import and Export Fair Complex, Guangzhou',
    countryCode: 'CN',
    // Canton Fair Phase 1 (consumer goods/toys) — Spring 2026:
    startDate: new Date('2026-04-15'),
    endDate: new Date('2026-05-05'),
    categories: ['Toys & Games', 'Consumer Goods', 'Electronics', 'Home Products', 'Gifts & Premiums'],
    websiteUrl: 'https://www.cantonfair.org.cn',
    // Canton Fair's exhibitor directory requires authentication; seed metadata only.
    exhibitorPageUrl: 'https://www.cantonfair.org.cn/en-US/exhibitors',
    strategy: 'none',
    waitAfterLoadMs: 5000,
  },
  {
    name: "NRF Retail's Big Show",
    location: 'Javits Center, New York, NY',
    countryCode: 'US',
    // NRF 2027 (next January edition after our current March 2026 date):
    startDate: new Date('2027-01-10'),
    endDate: new Date('2027-01-13'),
    categories: [
      'Retail Technology', 'Consumer Packaged Goods', 'Apparel',
      'Food & Grocery', 'Health & Beauty', 'Home Goods',
    ],
    websiteUrl: 'https://nrfbigshow.nrf.com',
    exhibitorPageUrl: 'https://nrfbigshow.nrf.com/exhibitors',
    strategy: 'playwright-cards',
    selectors: {
      // NRF uses Next.js CSS modules — class names include a hash suffix that is
      // stable across page loads but may change after a site rebuild.
      // Verified 2026-03-25 against live nrfbigshow.nrf.com/exhibitors.
      card: '[class*="ExhibitorsBlock_exhibitor"]:not([class*="Section"]):not([class*="Description"]):not([class*="Logo"])',
      name: '[class*="ExhibitorsBlock_bold"]',
      // Exhibitor pages are internal NRF paths (/company/NNN); no external website shown.
      website: 'a[href*="http"]:not([href*="nrf.com"]):not([href*="mapyourshow"])',
      category: '[class*="ExhibitorsBlock_category"], [class*="ExhibitorsBlock_tag"]',
      booth: '[class*="boothSection"]',
      // NRF uses numbered pagination buttons; there's no single "next" button class.
      // We use the pagination arrow (right arrow) to advance pages.
      loadMoreButton: '[class*="paginationArrow"]:last-child',
    },
    maxPages: 50,
    waitAfterLoadMs: 4000,
  },
];

// ---------------------------------------------------------------------------
// Crawler
// ---------------------------------------------------------------------------

export class TradeShowCrawler extends BaseCrawler {
  readonly crawlerType = 'trade-show';

  async run(): Promise<CrawlResult> {
    const errors: string[] = [];
    const structuredErrors: StructuredCrawlError[] = [];
    let recordsFound = 0;
    let newRecordsFound = 0;
    let pagesScraped = 0;
    let browser: Browser | undefined;

    try {
      browser = await chromium.launch({ headless: true });

      for (const config of SHOW_CONFIGS) {
        try {
          const { showId, wasInserted } = await this.upsertShow(config);
          logger.info({ show: config.name, showId, wasInserted }, 'Trade show seeded');
          recordsFound++;
          if (wasInserted) newRecordsFound++;

          if (config.strategy === 'none') {
            logger.info({ show: config.name }, 'No public exhibitor directory — skipping exhibitor scrape');
            pagesScraped++;
            continue;
          }

          await this.sleep(this.rateLimitMs);

          const { count, pagesProcessed } = await this.scrapeExhibitors(browser, showId, config);
          recordsFound += count;
          newRecordsFound += count;
          pagesScraped += pagesProcessed;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error({ show: config.name, error: msg }, 'Failed to process trade show');
          const errorCode = classifyError(msg);
          const structError: StructuredCrawlError = {
            code: errorCode,
            domain: new URL(config.websiteUrl).hostname,
            message: msg,
            retryable: [CrawlErrorCode.TIMEOUT, CrawlErrorCode.NETWORK_ERROR].includes(errorCode),
            timestamp: new Date().toISOString(),
          };
          structuredErrors.push(structError);
          errors.push(`${config.name}: ${msg}`);
        }
      }
    } finally {
      await browser?.close();
    }

    return { crawlerType: this.crawlerType, recordsFound, newRecordsFound, pagesScraped, errors, structuredErrors };
  }

  // -------------------------------------------------------------------------
  // Upsert show metadata
  // -------------------------------------------------------------------------

  private async upsertShow(config: ShowConfig): Promise<{ showId: string; wasInserted: boolean }> {
    const existing = await db
      .select({ id: tradeShows.id })
      .from(tradeShows)
      .where(eq(tradeShows.name, config.name))
      .limit(1);

    if (existing.length > 0) {
      const id = existing[0].id;
      await db
        .update(tradeShows)
        .set({
          location: config.location,
          countryCode: config.countryCode,
          startDate: config.startDate,
          endDate: config.endDate,
          categories: config.categories,
          websiteUrl: config.websiteUrl,
        })
        .where(eq(tradeShows.id, id));
      return { showId: id, wasInserted: false };
    }

    const [inserted] = await db
      .insert(tradeShows)
      .values({
        name: config.name,
        location: config.location,
        countryCode: config.countryCode,
        startDate: config.startDate,
        endDate: config.endDate,
        categories: config.categories,
        websiteUrl: config.websiteUrl,
      })
      .returning({ id: tradeShows.id });

    return { showId: inserted.id, wasInserted: true };
  }

  // -------------------------------------------------------------------------
  // Exhibitor scraping
  // -------------------------------------------------------------------------

  private async scrapeExhibitors(
    browser: Browser,
    showId: string,
    config: ShowConfig,
  ): Promise<{ count: number; pagesProcessed: number }> {
    const log = logger.child({ show: config.name });
    const context = await browser.newContext({
      userAgent: this.getNextUserAgent(),
    });
    const page = await context.newPage();

    // Block images, fonts, and media to speed up page loads.
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'media', 'font'].includes(type)) {
        void route.abort();
      } else {
        void route.continue();
      }
    });

    let totalInserted = 0;
    let pagesProcessed = 0;

    try {
      log.info({ url: config.exhibitorPageUrl }, 'Navigating to exhibitor page');

      await this.withRetry(
        () => page.goto(config.exhibitorPageUrl, { waitUntil: 'networkidle', timeout: 30_000 }),
        `navigate:${config.name}`,
      );

      await this.sleep(config.waitAfterLoadMs ?? 2000);

      const maxPages = config.strategy === 'playwright-cards' ? (config.maxPages ?? 10) : 1;

      for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
        const html = await page.content();
        const exhibitors = this.parseExhibitorCards(html, config.selectors);

        if (exhibitors.length === 0) {
          log.info({ pageNum }, 'No exhibitors found on page — stopping pagination');
          break;
        }

        // Measure selector confidence
        const $ = cheerio.load(html);
        if (config.selectors) {
          const confidence = this.measureSelectorConfidence($, [
            { name: 'card', selector: config.selectors.card, expectedMin: 5 },
          ]);
          if (confidence.card.confidence < 0.5) {
            log.warn({ confidence: confidence.card }, 'Low selector confidence for exhibitor cards');
          }
        }

        log.info({ pageNum, count: exhibitors.length }, 'Parsed exhibitors from page');

        const inserted = await this.insertExhibitors(showId, exhibitors);
        totalInserted += inserted;
        pagesProcessed++;

        // Try to navigate to next page
        const advanced = await this.advancePage(page, config.selectors?.loadMoreButton, pageNum);
        if (!advanced) break;

        await this.sleep(this.rateLimitMs);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ error: msg }, 'Exhibitor scrape failed — partial results may have been saved');
      throw err;
    } finally {
      await page.close();
      await context.close();
    }

    log.info({ totalInserted, pagesProcessed }, 'Exhibitor scrape complete');
    return { count: totalInserted, pagesProcessed };
  }

  /** Parse exhibitor cards from raw HTML using Cheerio. */
  private parseExhibitorCards(
    html: string,
    selectors?: ShowSelectors,
  ): Array<{ brandName: string; brandWebsite?: string; categories?: string[]; boothInfo?: string }> {
    if (!selectors) return [];

    const $ = cheerio.load(html);
    const results: Array<{
      brandName: string;
      brandWebsite?: string;
      categories?: string[];
      boothInfo?: string;
    }> = [];

    $(selectors.card).each((_, el) => {
      const card = $(el);

      const rawName = selectors.name
        ? card.find(selectors.name).first().text().trim()
        : card.text().trim().split('\n')[0].trim();

      if (!rawName || rawName.length < 2) return;

      const brandWebsite = selectors.website
        ? (card.find(selectors.website).first().attr('href') ?? undefined)
        : undefined;

      const categories = selectors.category
        ? card
            .find(selectors.category)
            .map((_, el) => $(el).text().trim())
            .get()
            .filter(Boolean)
        : undefined;

      const boothInfo = selectors.booth
        ? (card.find(selectors.booth).first().text().trim() || undefined)
        : undefined;

      results.push({
        brandName: rawName,
        brandWebsite: brandWebsite ? this.normaliseUrl(brandWebsite) : undefined,
        categories: categories && categories.length > 0 ? categories : undefined,
        boothInfo,
      });
    });

    return results;
  }

  /** Insert a batch of exhibitors, skipping duplicates for this show. */
  private async insertExhibitors(
    showId: string,
    exhibitors: Array<{
      brandName: string;
      brandWebsite?: string;
      categories?: string[];
      boothInfo?: string;
    }>,
  ): Promise<number> {
    if (exhibitors.length === 0) return 0;

    // Fetch existing exhibitor names for this show to skip duplicates.
    const existing = await db
      .select({ brandName: tradeShowExhibitors.brandName })
      .from(tradeShowExhibitors)
      .where(eq(tradeShowExhibitors.tradeShowId, showId));

    const existingNames = new Set(existing.map((e) => e.brandName.toLowerCase()));

    const toInsert = exhibitors.filter(
      (e) => !existingNames.has(e.brandName.toLowerCase()),
    );

    if (toInsert.length === 0) return 0;

    await db.insert(tradeShowExhibitors).values(
      toInsert.map((e) => ({
        tradeShowId: showId,
        brandName: e.brandName,
        brandWebsite: e.brandWebsite,
        categories: e.categories,
        boothInfo: e.boothInfo,
      })),
    );

    return toInsert.length;
  }

  /**
   * Attempt to navigate to the next page of results.
   * Returns false when no more pages are available.
   */
  private async advancePage(
    page: Page,
    loadMoreSelector: string | undefined,
    currentPage: number,
  ): Promise<boolean> {
    if (!loadMoreSelector) return false;

    try {
      const btn = page.locator(loadMoreSelector).first();
      const visible = await btn.isVisible({ timeout: 3000 });
      if (!visible) return false;

      const disabled = await btn.isDisabled({ timeout: 1000 });
      if (disabled) return false;

      await btn.click();
      await page.waitForLoadState('networkidle', { timeout: 15_000 });
      logger.debug({ currentPage }, 'Navigated to next exhibitor page');
      return true;
    } catch (err) {
      // Surface the error — click/waitForLoadState failures (timeouts, network errors)
      // are not normal pagination stops; they indicate a real crawl problem.
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ currentPage, error: msg }, 'advancePage failed — stopping pagination');
      return false;
    }
  }

  private normaliseUrl(href: string): string {
    try {
      const url = new URL(href);
      return url.origin + url.pathname;
    } catch {
      return href;
    }
  }
}
