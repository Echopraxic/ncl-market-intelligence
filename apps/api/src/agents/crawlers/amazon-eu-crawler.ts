import { chromium } from 'playwright-extra';
import type { Browser, BrowserContext, Page } from 'playwright';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import { db } from '@/db/index.js';
import { euMarketSignals } from '@/db/schema.js';
import { logger } from '@/lib/logger.js';
import { eq, and, gte, sql } from 'drizzle-orm';
import { BaseCrawler, type CrawlResult } from './base-crawler.js';
import { CrawlErrorCode, StructuredCrawlError, classifyError } from '@/lib/crawler-errors.js';

// ---------------------------------------------------------------------------
// Apply stealth plugin globally
// ---------------------------------------------------------------------------
chromium.use(StealthPlugin());

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AmazonDomain =
  | 'amazon.de'
  | 'amazon.fr'
  | 'amazon.co.uk'
  | 'amazon.it'
  | 'amazon.es'
  | 'amazon.pl';

type PageType = 'bestsellers' | 'new-releases';

type CategoryConfig = {
  categoryName: string;
  urlSlug: string;
  categoryPath: string;
  hasNewReleases: boolean;
};

type DomainConfig = {
  domain: AmazonDomain;
  countryCode: string;
  currency: string;
  baseUrl: string;
  locale: string;
  timezoneId: string;
  languageHeader: string;
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
  priceValid?: boolean;
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
// Mobile-first viewport pool — Amazon trusts mobile sessions more
// ---------------------------------------------------------------------------

const MOBILE_PROFILES = [
  {
    userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36',
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2.625,
    platform: 'Android',
    isMobile: true,
    hasTouch: true,
  },
  {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/135.0.0.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 3,
    platform: 'iPhone',
    isMobile: true,
    hasTouch: true,
  },
  {
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36',
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2.625,
    platform: 'Android',
    isMobile: true,
    hasTouch: true,
  },
  {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    platform: 'iPhone',
    isMobile: true,
    hasTouch: true,
  },
];

// ---------------------------------------------------------------------------
// Configuration — Expanded to 6 major EU markets
//
// Justification for expansion:
// • Italy (amazon.it): ~170M monthly visitors, growing steadily, lower competition
//   than DE/UK. Strong in fashion, kitchen, home, personal care [^26^][^29^]
// • Spain (amazon.es): ~140M monthly visitors, strategic entry point for LATAM
//   sellers, strong in sports/outdoors, home improvement [^26^][^29^]
// • Poland (amazon.pl): 36.6M population, fastest-growing EU digital market,
//   €25B e-commerce market, 11 fulfillment centers, very low competition [^28^][^29^]
//
// Portugal: Amazon has no dedicated marketplace (amazon.pt redirects to ES).
// Including PT would require scraping ES and filtering, adding complexity
// without unique signal value.
// ---------------------------------------------------------------------------

const DOMAIN_CONFIGS: DomainConfig[] = [
  {
    domain: 'amazon.de',
    countryCode: 'DE',
    currency: 'EUR',
    baseUrl: 'https://www.amazon.de',
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
    languageHeader: 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
  },
  {
    domain: 'amazon.fr',
    countryCode: 'FR',
    currency: 'EUR',
    baseUrl: 'https://www.amazon.fr',
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
    languageHeader: 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
  },
  {
    domain: 'amazon.co.uk',
    countryCode: 'GB',
    currency: 'GBP',
    baseUrl: 'https://www.amazon.co.uk',
    locale: 'en-GB',
    timezoneId: 'Europe/London',
    languageHeader: 'en-GB,en;q=0.9',
  },
  {
    domain: 'amazon.it',
    countryCode: 'IT',
    currency: 'EUR',
    baseUrl: 'https://www.amazon.it',
    locale: 'it-IT',
    timezoneId: 'Europe/Rome',
    languageHeader: 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
  },
  {
    domain: 'amazon.es',
    countryCode: 'ES',
    currency: 'EUR',
    baseUrl: 'https://www.amazon.es',
    locale: 'es-ES',
    timezoneId: 'Europe/Madrid',
    languageHeader: 'es-ES,es;q=0.9,en-US;q=0.8,en;q=0.7',
  },
  {
    domain: 'amazon.pl',
    countryCode: 'PL',
    currency: 'PLN',
    baseUrl: 'https://www.amazon.pl',
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    languageHeader: 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7',
  },
];

// ---------------------------------------------------------------------------
// Category configuration — same 5 categories, all support new-releases
// where available. Grocery and Home now have new-releases enabled
// based on 2026 Amazon EU layout updates.
// ---------------------------------------------------------------------------

const CATEGORIES: CategoryConfig[] = [
  { categoryName: 'toys_games',              urlSlug: 'toys-games',           categoryPath: 'Toys & Games',           hasNewReleases: true  },
  { categoryName: 'cosmetics_personal_care', urlSlug: 'beauty',               categoryPath: 'Beauty',                  hasNewReleases: true  },
  { categoryName: 'supplements',             urlSlug: 'health-personal-care', categoryPath: 'Health & Personal Care',  hasNewReleases: true  },
  { categoryName: 'food_beverage',           urlSlug: 'grocery',              categoryPath: 'Grocery',                 hasNewReleases: true  },
  { categoryName: 'home_goods',              urlSlug: 'home-garden',          categoryPath: 'Home & Kitchen',          hasNewReleases: true  },
];

// ---------------------------------------------------------------------------
// Selectors — expanded with mobile-specific fallbacks
// ---------------------------------------------------------------------------

const SELECTORS: AmazonSelectors = {
  product:     'ol#zg-ordered-list li, li.zg-item-immersion, div.zg-item-immersion, div[class*="zg-item"], [data-asin]',
  rank:        '.zg-bdg-text, span[class*="zg-bdg"], .zg-bdg-wrapper span, .aok-inline-block .a-text-bold',
  title:       '.p13n-sc-line-clamp-2 a span, .p13n-sc-truncate-desktop-type2, h2 a span, .p13n-sc-truncate, [data-cy="title-recipe-title"] span, .a-size-base-plus',
  link:        'h2 a, .p13n-sc-line-clamp-2 a, a.a-link-normal[href*="/dp/"], a[href*="/dp/"]',
  reviewCount: 'span[aria-label$=" ratings"], span[aria-label$=" Bewertungen"], span[aria-label$=" évaluations"], span[aria-label$=" beoordelingen"], span[aria-label$=" recensioni"], span[aria-label$=" valoraciones"], span[aria-label$=" opinie"], a[href*="reviews"] span',
  rating:      '.a-icon-star-small .a-icon-alt, .a-icon-alt, span[aria-label*="stars"], span[aria-label*="Sterne"], span[aria-label*="stelle"], span[aria-label*="estrellas"], span[aria-label*="gwiazdy"]',
  price:       '.p13n-sc-price, .a-price .a-offscreen, .a-price-whole, .a-price-range, .a-color-price',
  badge:       '.a-badge-text, .p13n-best-seller-badge, .a-badge-label, span[class*="badge"]',
};

// ---------------------------------------------------------------------------
// Crawler
// ---------------------------------------------------------------------------

export class AmazonEUCrawler extends BaseCrawler {
  readonly crawlerType = 'amazon-eu';

  private browser: Browser | undefined;
  private readonly maxPagesPerCategory = 1;
  private domainTrackers = new Map<string, { lastRequestAt: number; consecutiveFailures: number }>();
  private circuitBreakerFailures = 0;
  private readonly CIRCUIT_BREAKER_THRESHOLD = 8;
  private readonly CIRCUIT_BREAKER_COOLDOWN_MS = 90_000;
  private circuitBreakerTrippedAt: number | null = null;

  async run(): Promise<CrawlResult> {
    const errors: string[] = [];
    const structuredErrors: StructuredCrawlError[] = [];
    let recordsFound = 0;
    let newRecordsFound = 0;
    let pagesScraped = 0;

    try {
      this.browser = await this.launchStealthBrowser();

      // Sequential domain processing — one at a time to avoid cross-domain
      // correlation by Amazon's behavioral AI. This is the zero-cost alternative
      // to isolated proxies per domain.
      for (const domainConfig of DOMAIN_CONFIGS) {
        const result = await this.scrapeDomain(domainConfig);
        recordsFound += result.recordsFound;
        newRecordsFound += result.newRecordsFound;
        pagesScraped += result.pagesScraped;
        errors.push(...result.errors);
        structuredErrors.push(...result.structuredErrors);

        // Inter-domain cooldown with Gaussian jitter to break timing patterns
        if (domainConfig !== DOMAIN_CONFIGS[DOMAIN_CONFIGS.length - 1]) {
          await this.gaussianSleep(8000, 2500);
        }
      }
    } finally {
      await this.browser?.close();
    }

    return { crawlerType: this.crawlerType, recordsFound, newRecordsFound, pagesScraped, errors, structuredErrors };
  }

  // -------------------------------------------------------------------------
  // Stealth browser launch
  // -------------------------------------------------------------------------

  private async launchStealthBrowser(): Promise<Browser> {
    return chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=412,915',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
    });
  }

  // -------------------------------------------------------------------------
  // Domain scraping — sequential, with session persistence
  // -------------------------------------------------------------------------

  private async scrapeDomain(domainConfig: DomainConfig): Promise<{
    recordsFound: number;
    newRecordsFound: number;
    pagesScraped: number;
    errors: string[];
    structuredErrors: StructuredCrawlError[];
  }> {
    const errors: string[] = [];
    const structuredErrors: StructuredCrawlError[] = [];
    let recordsFound = 0;
    let newRecordsFound = 0;
    let pagesScraped = 0;
    let domainBlocked = false;

    // Create one persistent context per domain (not per category)
    // Warm it up with a homepage visit to establish session cookies
    const { page: warmupPage, context } = await this.createStealthContext(domainConfig);

    try {
      // Warm-up: visit homepage to establish legitimate session
      logger.info({ domain: domainConfig.domain }, 'Warming up session with homepage visit');
      await warmupPage.goto(domainConfig.baseUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      await this.gaussianSleep(3000, 800);
      await warmupPage.close();

      for (const category of CATEGORIES) {
        if (domainBlocked) break;

        // Circuit breaker check
        if (this.isCircuitBreakerOpen()) {
          logger.warn('Circuit breaker open — pausing domain crawl');
          const waitTime = this.CIRCUIT_BREAKER_COOLDOWN_MS - (Date.now() - (this.circuitBreakerTrippedAt ?? 0));
          if (waitTime > 0) await this.sleep(waitTime);
          this.resetCircuitBreaker();
        }

        // Per-domain rate limiting with exponential backoff
        await this.enforceDomainRateLimit(domainConfig.domain);

        try {
          const bestsellerResult = await this.scrapeCategoryPage(context, domainConfig, category, 'bestsellers');
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

          // Data quality validation: flag if results look like decoy data
          if (bestsellerResult.decoyDetected) {
            logger.warn({ domain: domainConfig.domain, category: category.categoryName }, 'Decoy data detected — skipping insertion');
            const decoyError: StructuredCrawlError = {
              code: CrawlErrorCode.DATA_QUALITY,
              domain: domainConfig.domain,
              category: category.categoryName,
              message: 'Decoy data detected — possible bot serving',
              retryable: true,
              timestamp: new Date().toISOString(),
            };
            structuredErrors.push(decoyError);
          } else {
            recordsFound += bestsellerResult.count;
            newRecordsFound += bestsellerResult.newRecordsFound ?? 0;
            pagesScraped += bestsellerResult.pagesScraped;
          }

          if (category.hasNewReleases && !domainBlocked) {
            await this.gaussianSleep(4000, 1200);
            const newReleasesResult = await this.scrapeCategoryPage(context, domainConfig, category, 'new-releases');
            if (newReleasesResult.botBlocked) {
              domainBlocked = true;
              break;
            }
            if (!newReleasesResult.decoyDetected) {
              recordsFound += newReleasesResult.count;
              newRecordsFound += newReleasesResult.newRecordsFound ?? 0;
              pagesScraped += newReleasesResult.pagesScraped;
            }
          }

          // Category-to-category delay with Gaussian distribution
          await this.gaussianSleep(3500, 1000);
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
          this.recordFailure(domainConfig.domain);
          await this.gaussianSleep(12000, 3000);
        }
      }
    } finally {
      await context.close();
    }

    return { recordsFound, newRecordsFound, pagesScraped, errors, structuredErrors };
  }

  // -------------------------------------------------------------------------
  // Stealth context creation with mobile-first fingerprinting
  // -------------------------------------------------------------------------

  private async createStealthContext(domainConfig: DomainConfig): Promise<{ page: Page; context: BrowserContext }> {
    if (!this.browser) throw new Error('Browser not initialized');

    const profile = MOBILE_PROFILES[Math.floor(Math.random() * MOBILE_PROFILES.length)];

    const context = await this.browser.newContext({
      userAgent: profile.userAgent,
      viewport: profile.viewport,
      deviceScaleFactor: profile.deviceScaleFactor,
      isMobile: profile.isMobile,
      hasTouch: profile.hasTouch,
      locale: domainConfig.locale,
      timezoneId: domainConfig.timezoneId,
      extraHTTPHeaders: {
        'Accept-Language': domainConfig.languageHeader,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
        'sec-ch-ua': '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
        'sec-ch-ua-mobile': '?1',
        'sec-ch-ua-platform': profile.platform,
      },
    });

    const page = await context.newPage();

    // Stealth plugin handles navigator.webdriver, plugins, canvas, WebGL
    // We add only locale-specific anti-detection scripts
    await page.addInitScript(`
      Object.defineProperty(navigator, 'languages', { get: () => ['${domainConfig.locale.split('-')[0]}', 'en-US', 'en'] });
      Object.defineProperty(navigator, 'platform', { get: () => '${profile.platform === 'Android' ? 'Linux armv8l' : 'iPhone'}' });
    `);

    return { page, context };
  }

  // -------------------------------------------------------------------------
  // Page scraping
  // -------------------------------------------------------------------------

  private async scrapeCategoryPage(
    context: BrowserContext,
    domainConfig: DomainConfig,
    category: CategoryConfig,
    pageType: PageType,
  ): Promise<{ count: number; botBlocked: boolean; decoyDetected: boolean; newRecordsFound: number; pagesScraped: number }> {
    const log = logger.child({ domain: domainConfig.domain, category: category.categoryName, pageType });
    const page = await context.newPage();
    const allProducts: ParsedProduct[] = [];
    let pagesScraped = 0;
    let decoyDetected = false;

    try {
      for (let pageNum = 1; pageNum <= this.maxPagesPerCategory; pageNum++) {
        const url = this.buildUrl(domainConfig, category, pageType, pageNum);
        log.info({ url, pageNum }, 'Navigating to Amazon page');

        const response = await this.withRetry(
          () => page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 }),
          `navigate:${domainConfig.domain}:${category.categoryName}:${pageNum}`,
          2,
        );
        pagesScraped++;

        // Bot detection check
        const currentUrl = page.url();
        const pageTitle = await page.title().catch(() => '');
        if (this.isBotBlocked(currentUrl, pageTitle)) {
          log.warn({ currentUrl, pageTitle }, 'Amazon bot detection detected');
          return { count: 0, botBlocked: true, decoyDetected: false, newRecordsFound: 0, pagesScraped };
        }

        // Human-like interaction: random scroll with variable velocity
        await this.simulateHumanScroll(page);
        await this.gaussianSleep(2500, 600);

        const { html } = await this.captureRenderedDOM(page, {
          waitSelector: 'ol#zg-ordered-list, ol.zg-ordered-list, li.zg-item-immersion, [data-asin]',
          postLoadDelayMs: 2000,
        });

        const products = this.parseProducts(html, domainConfig, pageType);
        const $ = cheerio.load(html);

        // Selector confidence check — abort if too low
        const confidence = this.measureSelectorConfidence($, [
          { name: 'product', selector: 'ol#zg-ordered-list li, li.zg-item-immersion, [data-asin]', expectedMin: 15 },
        ]);

        if (confidence.product.confidence < 0.5) {
          log.warn({ confidence: confidence.product }, 'Low selector confidence — possible layout change or bot page');
          throw new Error(`SELECTOR_MISMATCH:${domainConfig.domain}:${category.categoryName}: found ${confidence.product.found}/${confidence.product.expectedMin} cards`);
        }

        // Decoy data detection
        decoyDetected = this.detectDecoyData(products);
        if (decoyDetected) {
          log.warn({ productCount: products.length }, 'Decoy data detected — aborting category');
          break;
        }

        if (products.length === 0) {
          log.info({ pageNum }, 'No products found — stopping pagination');
          break;
        }

        log.info({ pageNum, count: products.length }, 'Parsed products');
        allProducts.push(...products);

        const hasNext = await this.hasNextPage(page);
        if (!hasNext) break;

        await this.gaussianSleep(2500, 800);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ error: msg }, 'Category scrape failed — partial results may be saved');
      throw err;
    } finally {
      await page.close();
    }

    const { inserted, newRecords } = await this.insertCategorySignal(domainConfig, category, pageType, allProducts);
    log.info({ inserted, newRecords, decoyDetected }, 'Category signal upserted');
    return { count: inserted, botBlocked: false, decoyDetected, newRecordsFound: newRecords, pagesScraped };
  }

  // -------------------------------------------------------------------------
  // Bot block detection
  // -------------------------------------------------------------------------

  private isBotBlocked(url: string, title: string): boolean {
    const titleLower = title.toLowerCase();
    const blockedIndicators = [
      '/ap/signin',
      '/errors/',
      'captcha',
      'robot check',
      'verify',
      'security check',
      'access denied',
      'unusual traffic',
      'sorry',
    ];
    return blockedIndicators.some((ind) => url.includes(ind) || titleLower.includes(ind));
  }

  // -------------------------------------------------------------------------
  // Decoy data detection
  // -------------------------------------------------------------------------

  private detectDecoyData(products: ParsedProduct[]): boolean {
    if (products.length === 0) return false;

    // Check 1: All products have identical prices (suspicious)
    const prices = products.map((p) => p.price).filter(Boolean);
    if (prices.length > 5 && new Set(prices).size === 1) {
      return true;
    }

    // Check 2: Rank sequence is not monotonically increasing
    const ranks = products.map((p) => p.rank);
    for (let i = 1; i < ranks.length; i++) {
      if (ranks[i] <= ranks[i - 1]) {
        // Allow ties but not decreases
        if (ranks[i] < ranks[i - 1]) return true;
      }
    }

    // Check 3: ASIN format validation
    const invalidAsins = products.filter((p) => !/^[A-Z0-9]{10}$/.test(p.asin));
    if (invalidAsins.length > products.length * 0.3) {
      return true;
    }

    // Check 4: All products have 0 reviews on bestsellers page
    if (products.every((p) => p.reviewCount === 0) && products.length > 10) {
      return true;
    }

    // Check 5: Price format validation
    const validPricePattern = /^[€£$]?[\d\s,.]+$/;
    const invalidPrices = products.filter((p) => p.price && !validPricePattern.test(p.price));
    if (invalidPrices.length > products.length * 0.5) {
      return true;
    }

    return false;
  }

  // -------------------------------------------------------------------------
  // Human-like scroll simulation
  // -------------------------------------------------------------------------

  private async simulateHumanScroll(page: Page): Promise<void> {
    // Runs in browser context — document and window are valid there
    await page.evaluate(`
      (() => {
        const scrollHeight = document.body.scrollHeight;
        const viewportHeight = window.innerHeight;
        const steps = Math.floor(Math.random() * 3) + 2;
        for (let i = 1; i <= steps; i++) {
          const targetY = Math.min((scrollHeight / steps) * i, scrollHeight - viewportHeight);
          window.scrollTo({ top: targetY + Math.floor(Math.random() * 100) - 50, behavior: 'smooth' });
        }
      })()
    `);
  }

  // -------------------------------------------------------------------------
  // URL builder
  // -------------------------------------------------------------------------

  private buildUrl(
    domainConfig: DomainConfig,
    category: CategoryConfig,
    pageType: PageType,
    pageNum: number,
  ): string {
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
      const asin = $el.attr('data-asin') ?? $el.find('[data-asin]').first().attr('data-asin');
      if (!asin || seenAsins.has(asin)) return;
      seenAsins.add(asin);

      const title = $el.find(SELECTORS.title).first().text().trim();
      if (!title) return;

      const rankText = $el.find(SELECTORS.rank).first().text().trim();
      const rankMatch = rankText.match(/#?(\d+)/);
      const rank = rankMatch ? parseInt(rankMatch[1], 10) : (itemIndex + 1);

      const relativeLink = $el.find(SELECTORS.link).first().attr('href') ?? '';
      const url = relativeLink.startsWith('http')
        ? relativeLink
        : `${domainConfig.baseUrl}${relativeLink}`;

      const reviewText = $el.find(SELECTORS.reviewCount).text();
      const reviewMatch =
        reviewText.match(/([\d\s.,]+)\s*ratings/i) ||
        reviewText.match(/([\d\s.,]+)\s*Bewertungen/i) ||
        reviewText.match(/([\d\s.,]+)\s*évaluations/i) ||
        reviewText.match(/([\d\s.,]+)\s*beoordelingen/i) ||
        reviewText.match(/([\d\s.,]+)\s*recensioni/i) ||
        reviewText.match(/([\d\s.,]+)\s*valoraciones/i) ||
        reviewText.match(/([\d\s.,]+)\s*opinie/i);
      const reviewCount = reviewMatch ? this.parseNumber(reviewMatch[1]) : 0;

      const ratingText =
        $el.find(SELECTORS.rating).attr('aria-label') ??
        $el.find(SELECTORS.rating).text();
      const ratingMatch =
        ratingText.match(/(\d+[.,]?\d*)\s*out of\s*5/i) ||
        ratingText.match(/(\d+[.,]?\d*)\s*von\s*5/i) ||
        ratingText.match(/(\d+[.,]?\d*)\s*sur\s*5/i) ||
        ratingText.match(/(\d+[.,]?\d*)\s*di\s*5/i) ||
        ratingText.match(/(\d+[.,]?\d*)\s*van\s*5/i) ||
        ratingText.match(/(\d+[.,]?\d*)\s*z\s*5/i);
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
      const nextBtn = page.locator('.a-pagination .a-last:not(.a-disabled), .zg-pagination a[href*="pg="], a:has-text("Next")').first();
      return await nextBtn.isVisible({ timeout: 2000 });
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Database write with functional index hint
  // -------------------------------------------------------------------------

  private async insertCategorySignal(
    domainConfig: DomainConfig,
    category: CategoryConfig,
    pageType: PageType,
    products: ParsedProduct[],
  ): Promise<{ inserted: number; newRecords: number }> {
    if (products.length === 0) return { inserted: 0, newRecords: 0 };

    const signalCategory = category.categoryName;
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    // NOTE: For production performance, create this functional index:
    // CREATE INDEX idx_eu_market_signals_rawdata_pagetype
    // ON eu_market_signals ((raw_data->>'pageType'));
    // Or better, add a dedicated 'pageType' column to avoid JSON path scans.

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
  // Circuit breaker
  // -------------------------------------------------------------------------

  private isCircuitBreakerOpen(): boolean {
    if (this.circuitBreakerTrippedAt === null) return false;
    return Date.now() - this.circuitBreakerTrippedAt < this.CIRCUIT_BREAKER_COOLDOWN_MS;
  }

  private recordFailure(domain: string): void {
    this.circuitBreakerFailures++;
    if (this.circuitBreakerFailures >= this.CIRCUIT_BREAKER_THRESHOLD) {
      this.circuitBreakerTrippedAt = Date.now();
      logger.warn({ failures: this.circuitBreakerFailures }, 'Circuit breaker tripped');
    }

    const tracker = this.domainTrackers.get(domain);
    if (tracker) {
      tracker.consecutiveFailures++;
    }
  }

  private resetCircuitBreaker(): void {
    this.circuitBreakerFailures = 0;
    this.circuitBreakerTrippedAt = null;
    logger.info('Circuit breaker reset');
  }

  // -------------------------------------------------------------------------
  // Per-domain rate limiting with Gaussian jitter
  // -------------------------------------------------------------------------

  private async enforceDomainRateLimit(domain: string): Promise<void> {
    const now = Date.now();
    const tracker = this.domainTrackers.get(domain);

    if (tracker) {
      const elapsed = now - tracker.lastRequestAt;
      const baseDelay = this.rateLimitMs;
      const jitter = Math.floor(Math.random() * (baseDelay * 0.4));
      const requiredDelay = baseDelay + jitter;

      if (elapsed < requiredDelay) {
        await this.sleep(requiredDelay - elapsed);
      }

      if (tracker.consecutiveFailures > 2) {
        const backoffMs = Math.min(2 ** tracker.consecutiveFailures * 1000, 60_000);
        logger.debug({ domain, backoffMs }, 'Applying exponential backoff');
        await this.sleep(backoffMs);
      }
    }

    this.domainTrackers.set(domain, {
      lastRequestAt: Date.now(),
      consecutiveFailures: tracker?.consecutiveFailures ?? 0,
    });
  }

  // -------------------------------------------------------------------------
  // Gaussian-distributed sleep for human-like timing
  // -------------------------------------------------------------------------

  private async gaussianSleep(meanMs: number, stdDevMs: number): Promise<void> {
    // Box-Muller transform for normal distribution
    const u1 = Math.random();
    const u2 = Math.random();
    const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
    const delay = Math.max(500, meanMs + z * stdDevMs); // minimum 500ms
    await this.sleep(Math.round(delay));
  }

  // -------------------------------------------------------------------------
  // Selector confidence measurement
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // DOM capture with explicit wait
  // -------------------------------------------------------------------------

  protected override async captureRenderedDOM(
    page: Page,
    opts?: { waitSelector?: string; postLoadDelayMs?: number },
  ): Promise<{ html: string; loadTimeMs: number }> {
    const start = Date.now();
    if (opts?.waitSelector) {
      try {
        await page.waitForSelector(opts.waitSelector, { timeout: 10_000 });
      } catch {
        // Selector not found — page may be blocked or layout changed
      }
    }
    await this.sleep(opts?.postLoadDelayMs ?? 0);
    const html = await page.content();
    return { html, loadTimeMs: Date.now() - start };
  }

  // -------------------------------------------------------------------------
  // Velocity score
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
    if (product.rating && product.rating >= 4.7) score += 5;
    return Math.round(score);
  }

  private parseNumber(str: string): number {
    return parseInt(str.replace(/[\s.,]/g, ''), 10) || 0;
  }
}
