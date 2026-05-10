import { chromium, type Browser, type Page, type BrowserContext } from 'playwright-extra';
import type { Route } from 'playwright';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import { db } from '@/db/index.js';
import { brands, products } from '@/db/schema.js';
import { logger } from '@/lib/logger.js';
import { eq, isNull, and } from 'drizzle-orm';
import { BaseCrawler, type CrawlResult } from './base-crawler.js';
import { CrawlErrorCode, StructuredCrawlError, classifyError } from '@/lib/crawler-errors.js';

// ---------------------------------------------------------------------------
// Apply stealth plugin globally to chromium
// ---------------------------------------------------------------------------
chromium.use(StealthPlugin());

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SeedEntry = {
  domain: string;
  expectedCategories: string[];
  segment: 'toys' | 'cpg' | 'wellness' | 'home-goods';
};

type BrandMetadata = {
  name: string;
  websiteUrl: string;
  shopifyStoreUrl?: string;
  categories: string[];
  isShopify: boolean;
  productCount: number;
  description?: string;
  segment: 'toys' | 'cpg' | 'wellness' | 'home-goods' | 'other';
  status: 'active' | 'migrated' | 'blocked' | 'timeout' | 'error';
};

type DomainTracker = {
  domain: string;
  lastRequestAt: number;
  consecutiveFailures: number;
  totalRequests: number;
};

// ---------------------------------------------------------------------------
// Comprehensive keyword-based segmentation taxonomy
// ---------------------------------------------------------------------------

const SEGMENT_KEYWORDS: Record<string, { segment: BrandMetadata['segment']; weight: number }[]> = {
  // ---- Toys & Games --------------------------------------------------------
  toys: [{ segment: 'toys', weight: 10 }],
  'educational toys': [{ segment: 'toys', weight: 10 }],
  'stem toys': [{ segment: 'toys', weight: 10 }],
  'building blocks': [{ segment: 'toys', weight: 10 }],
  'board games': [{ segment: 'toys', weight: 10 }],
  'puzzle games': [{ segment: 'toys', weight: 10 }],
  'learning kits': [{ segment: 'toys', weight: 10 }],
  'science kits': [{ segment: 'toys', weight: 10 }],
  'art supplies': [{ segment: 'toys', weight: 10 }],
  'craft kits': [{ segment: 'toys', weight: 10 }],
  'wooden toys': [{ segment: 'toys', weight: 10 }],
  puppet: [{ segment: 'toys', weight: 10 }],
  plush: [{ segment: 'toys', weight: 10 }],
  'imaginative play': [{ segment: 'toys', weight: 10 }],
  'brain teasers': [{ segment: 'toys', weight: 10 }],
  'magnetic building': [{ segment: 'toys', weight: 10 }],
  construction: [{ segment: 'toys', weight: 8 }],
  doll: [{ segment: 'toys', weight: 9 }],
  'action figure': [{ segment: 'toys', weight: 9 }],
  lego: [{ segment: 'toys', weight: 10 }],
  'remote control': [{ segment: 'toys', weight: 9 }],
  'model kit': [{ segment: 'toys', weight: 9 }],
  'play set': [{ segment: 'toys', weight: 10 }],
  'stuffed animal': [{ segment: 'toys', weight: 9 }],
  'educational game': [{ segment: 'toys', weight: 10 }],
  'montessori': [{ segment: 'toys', weight: 9 }],
  'waldorf': [{ segment: 'toys', weight: 9 }],

  // ---- CPG / Food & Beverage -----------------------------------------------
  snack: [{ segment: 'cpg', weight: 10 }],
  'organic snack': [{ segment: 'cpg', weight: 10 }],
  'plant-based': [{ segment: 'cpg', weight: 9 }],
  'craft coffee': [{ segment: 'cpg', weight: 10 }],
  'specialty tea': [{ segment: 'cpg', weight: 10 }],
  'artisan chocolate': [{ segment: 'cpg', weight: 10 }],
  'energy drink': [{ segment: 'cpg', weight: 10 }],
  kombucha: [{ segment: 'cpg', weight: 10 }],
  'beef jerky': [{ segment: 'cpg', weight: 10 }],
  'meat snack': [{ segment: 'cpg', weight: 10 }],
  'nut butter': [{ segment: 'cpg', weight: 10 }],
  'gourmet spice': [{ segment: 'cpg', weight: 10 }],
  'specialty sauce': [{ segment: 'cpg', weight: 10 }],
  'gluten-free': [{ segment: 'cpg', weight: 8 }],
  'vegan cheese': [{ segment: 'cpg', weight: 10 }],
  'premium granola': [{ segment: 'cpg', weight: 10 }],
  'protein bar': [{ segment: 'cpg', weight: 10 }],
  paleo: [{ segment: 'cpg', weight: 8 }],
  keto: [{ segment: 'cpg', weight: 8 }],
  'mexican-american': [{ segment: 'cpg', weight: 10 }],
  confectionery: [{ segment: 'cpg', weight: 10 }],
  'better-for-you': [{ segment: 'cpg', weight: 9 }],
  beverage: [{ segment: 'cpg', weight: 9 }],
  'hot sauce': [{ segment: 'cpg', weight: 10 }],
  'olive oil': [{ segment: 'cpg', weight: 9 }],
  'specialty food': [{ segment: 'cpg', weight: 10 }],
  'meal kit': [{ segment: 'cpg', weight: 9 }],
  'baby food': [{ segment: 'cpg', weight: 9 }],
  pet: [{ segment: 'cpg', weight: 7 }],
  'pet food': [{ segment: 'cpg', weight: 8 }],
  'pet treat': [{ segment: 'cpg', weight: 8 }],

  // ---- Wellness / Supplements ----------------------------------------------
  'collagen powder': [{ segment: 'wellness', weight: 10 }],
  'protein powder': [{ segment: 'wellness', weight: 10 }],
  'cbd product': [{ segment: 'wellness', weight: 10 }],
  nootropic: [{ segment: 'wellness', weight: 10 }],
  superfood: [{ segment: 'wellness', weight: 10 }],
  probiotic: [{ segment: 'wellness', weight: 10 }],
  'omega-3': [{ segment: 'wellness', weight: 10 }],
  adaptogen: [{ segment: 'wellness', weight: 10 }],
  multivitamin: [{ segment: 'wellness', weight: 10 }],
  'vitamin d': [{ segment: 'wellness', weight: 10 }],
  'wellness product': [{ segment: 'wellness', weight: 10 }],
  supplement: [{ segment: 'wellness', weight: 10 }],
  collagen: [{ segment: 'wellness', weight: 10 }],
  'gut health': [{ segment: 'wellness', weight: 10 }],
  'immune support': [{ segment: 'wellness', weight: 10 }],
  'sleep aid': [{ segment: 'wellness', weight: 10 }],
  'stress relief': [{ segment: 'wellness', weight: 10 }],
  'herbal supplement': [{ segment: 'wellness', weight: 10 }],
  'greens powder': [{ segment: 'wellness', weight: 10 }],
  'pre workout': [{ segment: 'wellness', weight: 9 }],
  'post workout': [{ segment: 'wellness', weight: 9 }],
  electrolyte: [{ segment: 'wellness', weight: 9 }],
  'mushroom supplement': [{ segment: 'wellness', weight: 10 }],
  turmeric: [{ segment: 'wellness', weight: 9 }],
  ashwagandha: [{ segment: 'wellness', weight: 10 }],
  'bone broth': [{ segment: 'wellness', weight: 9 }],
  'apple cider vinegar': [{ segment: 'wellness', weight: 8 }],
  'detox tea': [{ segment: 'wellness', weight: 9 }],
  'essential oil': [{ segment: 'wellness', weight: 7 }], // overlaps with cosmetics

  // ---- Home Goods ----------------------------------------------------------
  'sustainable home': [{ segment: 'home-goods', weight: 10 }],
  'eco-friendly bedding': [{ segment: 'home-goods', weight: 10 }],
  'luxury linen': [{ segment: 'home-goods', weight: 10 }],
  'home decor': [{ segment: 'home-goods', weight: 10 }],
  'kitchen gadget': [{ segment: 'home-goods', weight: 10 }],
  'smart home': [{ segment: 'home-goods', weight: 10 }],
  furniture: [{ segment: 'home-goods', weight: 10 }],
  'home organization': [{ segment: 'home-goods', weight: 10 }],
  'sustainable product': [{ segment: 'home-goods', weight: 9 }],
  bedding: [{ segment: 'home-goods', weight: 10 }],
  bath: [{ segment: 'home-goods', weight: 10 }],
  'home textile': [{ segment: 'home-goods', weight: 10 }],
  'personal care': [{ segment: 'home-goods', weight: 8 }],
  cleaning: [{ segment: 'home-goods', weight: 8 }],
  sustainable: [{ segment: 'home-goods', weight: 7 }],
  candle: [{ segment: 'home-goods', weight: 9 }],
  'air purifier': [{ segment: 'home-goods', weight: 10 }],
  'water filter': [{ segment: 'home-goods', weight: 10 }],
  'storage solution': [{ segment: 'home-goods', weight: 10 }],
  'throw pillow': [{ segment: 'home-goods', weight: 9 }],
  'tableware': [{ segment: 'home-goods', weight: 9 }],
  'cookware': [{ segment: 'home-goods', weight: 9 }],
  'cutlery': [{ segment: 'home-goods', weight: 9 }],
  'home fragrance': [{ segment: 'home-goods', weight: 9 }],
  'wall art': [{ segment: 'home-goods', weight: 9 }],
  'area rug': [{ segment: 'home-goods', weight: 9 }],
  'outdoor furniture': [{ segment: 'home-goods', weight: 9 }],
};

// ---------------------------------------------------------------------------
// Seed list
// ---------------------------------------------------------------------------

const SEED_BRANDS: SeedEntry[] = [
  // ---- Toys (8) ------------------------------------------------------------
  {
    domain: 'melissaanddoug.com',
    expectedCategories: ['Toys', 'Educational Toys', 'Arts & Crafts'],
    segment: 'toys',
  },
  {
    domain: 'fatbraintoys.com',
    expectedCategories: ['Toys', 'Educational Toys', 'STEM'],
    segment: 'toys',
  },
  {
    domain: 'learningresources.com',
    expectedCategories: ['Educational Toys', 'STEM', 'Classroom'],
    segment: 'toys',
  },
  {
    domain: 'thamesandkosmos.com',
    expectedCategories: ['STEM Kits', 'Science Toys', 'Games'],
    segment: 'toys',
  },
  {
    domain: 'magformers.com',
    expectedCategories: ['Magnetic Building Toys', 'STEM', 'Construction'],
    segment: 'toys',
  },
  {
    domain: 'folkmanis.com',
    expectedCategories: ['Puppets', 'Plush Toys', 'Imaginative Play'],
    segment: 'toys',
  },
  {
    domain: 'popularplaythings.com',
    expectedCategories: ['Puzzles', 'Games', 'Brain Teasers'],
    segment: 'toys',
  },
  {
    domain: 'geomag-world.com',
    expectedCategories: ['Magnetic Building Toys', 'STEM', 'Construction'],
    segment: 'toys',
  },

  // ---- CPG (3) -------------------------------------------------------------
  {
    domain: 'sietefoods.com',
    expectedCategories: ['Food & Beverage', 'Snacks', 'Mexican-American Foods'],
    segment: 'cpg',
  },
  {
    domain: 'chomps.com',
    expectedCategories: ['Meat Snacks', 'Protein Snacks', 'Paleo'],
    segment: 'cpg',
  },
  {
    domain: 'hukitchen.com',
    expectedCategories: ['Chocolate', 'Confectionery', 'Better-for-You Snacks'],
    segment: 'cpg',
  },

  // ---- Wellness (3) --------------------------------------------------------
  {
    domain: 'bulletproof.com',
    expectedCategories: ['Supplements', 'Coffee', 'Wellness'],
    segment: 'wellness',
  },
  {
    domain: 'ancientnutrition.com',
    expectedCategories: ['Supplements', 'Collagen', 'Gut Health'],
    segment: 'wellness',
  },
  {
    domain: 'oraorganic.com',
    expectedCategories: ['Organic Supplements', 'Vegan Vitamins', 'Wellness'],
    segment: 'wellness',
  },

  // ---- Home Goods (2) ------------------------------------------------------
  {
    domain: 'publicgoods.com',
    expectedCategories: ['Home Goods', 'Personal Care', 'Cleaning', 'Sustainable'],
    segment: 'home-goods',
  },
  {
    domain: 'parachutehome.com',
    expectedCategories: ['Bedding', 'Bath', 'Home Textiles'],
    segment: 'home-goods',
  },
];

// ---------------------------------------------------------------------------
// User agent pool with aligned platform hints
// ---------------------------------------------------------------------------

const USER_AGENT_POOL = [
  {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    platform: 'macOS',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  },
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    platform: 'Windows',
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  },
  {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    platform: 'macOS',
    viewport: { width: 1680, height: 1050 },
    deviceScaleFactor: 2,
  },
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0',
    platform: 'Windows',
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  },
  {
    ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    platform: 'Linux',
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  },
];

// ---------------------------------------------------------------------------
// Crawler
// ---------------------------------------------------------------------------

export class ShopifyBrandCrawler extends BaseCrawler {
  readonly crawlerType = 'shopify-brand';

  private domainTrackers = new Map<string, DomainTracker>();
  private circuitBreakerFailures = 0;
  private readonly CIRCUIT_BREAKER_THRESHOLD = 10;
  private readonly CIRCUIT_BREAKER_COOLDOWN_MS = 60_000;
  private circuitBreakerTrippedAt: number | null = null;

  async run(): Promise<CrawlResult> {
    const errors: string[] = [];
    const structuredErrors: StructuredCrawlError[] = [];
    let recordsFound = 0;
    let newRecordsFound = 0;
    let pagesScraped = 0;
    let browser: Browser | undefined;

    try {
      // Phase 0: Ensure seed brands exist in DB
      await this.seedDatabaseBrands();

      // Phase 1: Discover new candidate brands
      logger.info('Shopify crawler: starting brand discovery');
      const { discovered, added } = await this.discoverNewBrands();
      logger.info({ discovered, added }, 'Shopify crawler: discovery complete');

      browser = await this.launchStealthBrowser();

      // Phase 2: Scrape unchecked brands
      const toCheck = await this.getBrandsToCheck();
      logger.info({ count: toCheck.length }, 'Shopify crawler: brands to check');

      for (const item of toCheck) {
        // Circuit breaker check
        if (this.isCircuitBreakerOpen()) {
          logger.warn('Circuit breaker open — pausing crawl');
          const waitTime = this.CIRCUIT_BREAKER_COOLDOWN_MS - (Date.now() - (this.circuitBreakerTrippedAt ?? 0));
          if (waitTime > 0) await this.sleep(waitTime);
          this.resetCircuitBreaker();
        }

        // Per-domain rate limiting with jitter
        await this.enforceDomainRateLimit(item.websiteUrl);

        try {
          const metadata = await this.withRetry(
            () => this.scrapeStore(browser!, item.websiteUrl),
            `scrape:${item.websiteUrl}`,
          );

          if (!metadata) {
            logger.warn({ domain: item.websiteUrl }, 'Could not extract brand metadata — skipping');
            const netError: StructuredCrawlError = {
              code: CrawlErrorCode.NETWORK_ERROR,
              domain: item.websiteUrl,
              message: 'Could not extract brand metadata',
              retryable: true,
              timestamp: new Date().toISOString(),
            };
            structuredErrors.push(netError);
            this.recordFailure(item.websiteUrl);
            continue;
          }

          const { wasInserted } = await this.upsertBrand(metadata, item);
          recordsFound++;
          if (wasInserted) newRecordsFound++;
          pagesScraped++;

          // Record success resets circuit breaker
          this.recordSuccess(item.websiteUrl);

          logger.info(
            { domain: item.websiteUrl, brand: metadata.name, isShopify: metadata.isShopify, wasInserted, segment: metadata.segment },
            'Brand scraped and upserted',
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error({ domain: item.websiteUrl, error: msg }, 'Failed to scrape brand');
          const errorCode = classifyError(msg);
          const structError: StructuredCrawlError = {
            code: errorCode,
            domain: item.websiteUrl,
            message: msg,
            retryable: [CrawlErrorCode.TIMEOUT, CrawlErrorCode.NETWORK_ERROR].includes(errorCode),
            timestamp: new Date().toISOString(),
          };
          structuredErrors.push(structError);
          errors.push(`${item.websiteUrl}: ${msg}`);
          this.recordFailure(item.websiteUrl);
        }
      }
    } finally {
      await browser?.close();
    }

    return { crawlerType: this.crawlerType, recordsFound, newRecordsFound, pagesScraped, errors, structuredErrors };
  }

  // -------------------------------------------------------------------------
  // Stealth browser launch with aligned fingerprint
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
        '--window-size=1920,1080',
      ],
    });
  }

  private getStealthContext(browser: Browser): Promise<BrowserContext> {
    const profile = USER_AGENT_POOL[Math.floor(Math.random() * USER_AGENT_POOL.length)];
    const timezone = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London'][
      Math.floor(Math.random() * 5)
    ];
    const locale = 'en-US';

    return browser.newContext({
      userAgent: profile.ua,
      viewport: profile.viewport,
      deviceScaleFactor: profile.deviceScaleFactor,
      locale,
      timezoneId: timezone,
      extraHTTPHeaders: {
        'Accept-Language': `${locale},en;q=0.9`,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      },
    });
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

  private recordSuccess(domain: string): void {
    this.circuitBreakerFailures = Math.max(0, this.circuitBreakerFailures - 1);
    const tracker = this.domainTrackers.get(domain);
    if (tracker) {
      tracker.consecutiveFailures = 0;
      tracker.totalRequests++;
    }
  }

  private resetCircuitBreaker(): void {
    this.circuitBreakerFailures = 0;
    this.circuitBreakerTrippedAt = null;
    logger.info('Circuit breaker reset');
  }

  // -------------------------------------------------------------------------
  // Per-domain rate limiting with jitter
  // -------------------------------------------------------------------------

  private async enforceDomainRateLimit(websiteUrl: string): Promise<void> {
    const hostname = new URL(websiteUrl).hostname;
    const now = Date.now();
    const tracker = this.domainTrackers.get(hostname);

    if (tracker) {
      const elapsed = now - tracker.lastRequestAt;
      const baseDelay = this.rateLimitMs;
      const jitter = Math.floor(Math.random() * (baseDelay * 0.3));
      const requiredDelay = baseDelay + jitter;

      if (elapsed < requiredDelay) {
        await this.sleep(requiredDelay - elapsed);
      }

      // Exponential backoff for consecutive failures
      if (tracker.consecutiveFailures > 2) {
        const backoffMs = Math.min(2 ** tracker.consecutiveFailures * 1000, 30_000);
        logger.debug({ domain: hostname, backoffMs }, 'Applying exponential backoff');
        await this.sleep(backoffMs);
      }
    }

    this.domainTrackers.set(hostname, {
      domain: hostname,
      lastRequestAt: Date.now(),
      consecutiveFailures: tracker?.consecutiveFailures ?? 0,
      totalRequests: (tracker?.totalRequests ?? 0) + 1,
    });
  }

  // -------------------------------------------------------------------------
  // Get brands to check
  // -------------------------------------------------------------------------

  private async getBrandsToCheck(): Promise<Array<{ websiteUrl: string; segment?: string }>> {
    const seedUrls = SEED_BRANDS.map((s) => `https://${s.domain}`);

    const uncheckedBrands = await db
      .select({
        id: brands.id,
        websiteUrl: brands.websiteUrl,
      })
      .from(brands)
      .where(isNull(brands.shopifyStoreUrl))
      .limit(75);

    const toCheckItems = uncheckedBrands
      .filter((b) => b.websiteUrl && b.websiteUrl.startsWith('http'))
      .map((b) => {
        const isSeed = seedUrls.some((url) => url.toLowerCase() === b.websiteUrl!.toLowerCase());
        const segment = isSeed
          ? SEED_BRANDS.find((s) => `https://${s.domain}`.toLowerCase() === b.websiteUrl!.toLowerCase())?.segment
          : undefined;
        return {
          websiteUrl: b.websiteUrl!,
          segment,
          source: isSeed ? 'seed' : 'database',
        };
      });

    logger.info(
      {
        unchecked: toCheckItems.length,
        seed: toCheckItems.filter((t) => t.source === 'seed').length,
        discovered: toCheckItems.filter((t) => t.source === 'database').length,
      },
      'Shopify crawler: brand sources',
    );

    return toCheckItems;
  }

  // -------------------------------------------------------------------------
  // Scrape a single Shopify store
  // -------------------------------------------------------------------------

  private async scrapeStore(browser: Browser, websiteUrl: string): Promise<BrandMetadata | null> {
    const baseUrl = websiteUrl;
    const log = logger.child({ domain: baseUrl });
    const context = await this.getStealthContext(browser);
    const page = await context.newPage();

    // Block heavy assets for faster scraping
    await page.route('**/*', (route: Route) => {
      const type = route.request().resourceType();
      if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
        void route.abort();
      } else {
        void route.continue();
      }
    });

    try {
      log.info({ url: baseUrl }, 'Navigating to brand homepage');
      const response = await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });

      // Check for blocking / interstitial pages
      if (!response) {
        log.warn('No response from server');
        return null;
      }

      const status = response.status();
      if (status === 403 || status === 429) {
        log.warn({ status }, 'Access blocked by target');
        return {
          name: this.extractDomainName(baseUrl),
          websiteUrl: baseUrl,
          categories: ['general'],
          isShopify: false,
          productCount: 0,
          segment: 'other',
          status: 'blocked',
        };
      }

      // Random human-like delay
      await this.sleep(1500 + Math.floor(Math.random() * 1000));

      // Simulate human-like scroll
      await page.evaluate(`window.scrollBy(0, ${Math.floor(Math.random() * 300) + 100})`);
      await this.sleep(500 + Math.floor(Math.random() * 500));

      const html = await page.content();
      const isShopify = this.detectShopify(html);
      const metaTags = this.extractMetaTags(html);

      const domain = new URL(baseUrl).hostname ?? baseUrl.replace(/https?:\/\//, '');

      // Hit Shopify endpoints with proper error differentiation
      const { productCount, productCategories, endpointStatus } = await this.fetchShopifyProducts(page, domain);

      const name = this.resolveBrandName(metaTags, domain);

      // Determine segment from keyword matching
      const allCategorySignals = [
        ...(metaTags.title?.toLowerCase().split(/\s+/) ?? []),
        ...(metaTags.description?.toLowerCase().split(/\s+/) ?? []),
        ...(metaTags.ogSiteName?.toLowerCase().split(/\s+/) ?? []),
        ...productCategories.map((c) => c.toLowerCase()),
      ];
      const segment = this.classifySegment(allCategorySignals);

      // Normalize categories
      const categories = productCategories.length > 0
        ? this.normalizeCategories(productCategories)
        : ['general'];

      // Determine status
      let brandStatus: BrandMetadata['status'] = 'active';
      if (!isShopify) brandStatus = 'migrated';
      else if (endpointStatus === 'blocked') brandStatus = 'blocked';
      else if (endpointStatus === 'error') brandStatus = 'error';

      return {
        name,
        websiteUrl: baseUrl,
        shopifyStoreUrl: isShopify ? baseUrl : undefined,
        categories,
        isShopify,
        productCount,
        description: metaTags.description,
        segment,
        status: brandStatus,
      };
    } catch (err) {
      const errorMsg = (err as Error).message;
      log.warn({ error: errorMsg }, 'Scrape failed');

      // Distinguish timeout from other errors
      if (errorMsg.includes('timeout') || errorMsg.includes('Timeout')) {
        return {
          name: this.extractDomainName(baseUrl),
          websiteUrl: baseUrl,
          categories: ['general'],
          isShopify: false,
          productCount: 0,
          segment: 'other',
          status: 'timeout',
        };
      }

      return null;
    } finally {
      await page.close();
      await context.close();
    }
  }

  // -------------------------------------------------------------------------
  // Shopify product catalog probe with count.json fallback
  // -------------------------------------------------------------------------

  private async fetchShopifyProducts(
    page: Page,
    domain: string,
  ): Promise<{ productCount: number; productCategories: string[]; endpointStatus: 'ok' | 'blocked' | 'error' | 'not-shopify' }> {
    // Try count.json first for accurate product count
    let accurateCount = 0;
    let countStatus: 'ok' | 'blocked' | 'error' = 'error';

    try {
      const countResponse = await page.evaluate(async (url: string) => {
        try {
          const res = await fetch(url, {
            headers: { Accept: 'application/json' },
            method: 'GET',
          });
          if (res.status === 403 || res.status === 429) return { status: 'blocked', data: null };
          if (!res.ok) return { status: 'error', data: null };
          const data = await res.json();
          return { status: 'ok', data };
        } catch {
          return { status: 'error', data: null };
        }
      }, `https://${domain}/products/count.json`) as { status: string; data: { count?: number } | null };

      if (countResponse.status === 'ok' && countResponse.data?.count) {
        accurateCount = countResponse.data.count;
        countStatus = 'ok';
      } else if (countResponse.status === 'blocked') {
        countStatus = 'blocked';
      }
    } catch {
      // count.json unavailable — fall through to products.json
    }

    // Try products.json for categories and fallback count
    try {
      const response = await page.evaluate(async (url: string) => {
        try {
          const res = await fetch(url, { headers: { Accept: 'application/json' } });
          if (res.status === 403 || res.status === 429) return { status: 'blocked', data: null };
          if (!res.ok) return { status: 'error', data: null };
          const data = await res.json();
          return { status: 'ok', data };
        } catch {
          return { status: 'error', data: null };
        }
      }, `https://${domain}/products.json?limit=250`) as { status: string; data: { products?: Array<{ product_type?: string; tags?: string }> } | null };

      if (response.status === 'blocked') {
        return {
          productCount: accurateCount,
          productCategories: [],
          endpointStatus: 'blocked',
        };
      }

      if (response.status === 'error' || !response.data || !Array.isArray(response.data.products)) {
        return {
          productCount: accurateCount,
          productCategories: [],
          endpointStatus: countStatus === 'ok' ? 'ok' : 'not-shopify',
        };
      }

      const productsList = response.data.products;
      const productCount = accurateCount > 0 ? accurateCount : productsList.length;

      const rawTypes = productsList
        .map(p => p.product_type)
        .filter((t): t is string => Boolean(t));

      const rawTags = productsList
        .flatMap(p => (p.tags ? p.tags.split(',').map((t: string) => t.trim()) : []))
        .filter((t: string) => t.length > 2 && t.length < 50);

      const productCategories = [...new Set([...rawTypes, ...rawTags])].slice(0, 20);

      return { productCount, productCategories, endpointStatus: 'ok' };
    } catch {
      return {
        productCount: accurateCount,
        productCategories: [],
        endpointStatus: countStatus === 'ok' ? 'ok' : 'error',
      };
    }
  }

  // -------------------------------------------------------------------------
  // Comprehensive keyword-based segmentation
  // -------------------------------------------------------------------------

  private classifySegment(signals: string[]): BrandMetadata['segment'] {
    const scores: Record<BrandMetadata['segment'], number> = {
      toys: 0,
      cpg: 0,
      wellness: 0,
      'home-goods': 0,
      other: 0,
    };

    for (const signal of signals) {
      const normalizedSignal = signal.toLowerCase().trim();
      for (const [keyword, mappings] of Object.entries(SEGMENT_KEYWORDS)) {
        if (normalizedSignal.includes(keyword.toLowerCase())) {
          for (const mapping of mappings) {
            scores[mapping.segment] += mapping.weight;
          }
        }
      }
    }

    // Find highest scoring segment (excluding 'other')
    let bestSegment: BrandMetadata['segment'] = 'other';
    let bestScore = 0;

    for (const [segment, score] of Object.entries(scores) as [BrandMetadata['segment'], number][]) {
      if (segment !== 'other' && score > bestScore) {
        bestScore = score;
        bestSegment = segment;
      }
    }

    // Require minimum threshold to avoid misclassification
    return bestScore >= 5 ? bestSegment : 'other';
  }

  // -------------------------------------------------------------------------
  // Category normalization
  // -------------------------------------------------------------------------

  private normalizeCategories(rawCategories: string[]): string[] {
    const normalized = new Set<string>();

    for (const cat of rawCategories) {
      let normalizedCat = cat
        .toLowerCase()
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/[^a-z0-9\s&-]/g, '');

      // Deduplicate similar categories
      if (normalizedCat.includes('t-shirt')) normalizedCat = 't-shirts';
      if (normalizedCat.includes('tshirt')) normalizedCat = 't-shirts';
      if (normalizedCat.startsWith('men') && normalizedCat.includes('clothing')) normalizedCat = 'mens clothing';
      if (normalizedCat.startsWith('women') && normalizedCat.includes('clothing')) normalizedCat = 'womens clothing';

      if (normalizedCat.length > 2 && normalizedCat.length < 50) {
        normalized.add(normalizedCat);
      }
    }

    return [...normalized].slice(0, 20);
  }

  // -------------------------------------------------------------------------
  // HTML parsing helpers
  // -------------------------------------------------------------------------

  private detectShopify(html: string): boolean {
    const shopifySignals = [
      'cdn.shopify.com',
      'Shopify.shop',
      'myshopify.com',
      '/cart.js',
      'window.Shopify',
      'shopify-checkout',
      'shopify-payment-button',
      'shopify-section',
      'shopify-features',
    ];
    return shopifySignals.some((signal) => html.includes(signal));
  }

  private extractMetaTags(html: string): {
    title?: string;
    description?: string;
    ogTitle?: string;
    ogSiteName?: string;
    ogDescription?: string;
  } {
    const $ = cheerio.load(html);

    return {
      title: $('title').first().text().trim() || undefined,
      description: $('meta[name="description"]').attr('content')?.trim(),
      ogTitle: $('meta[property="og:title"]').attr('content')?.trim(),
      ogSiteName: $('meta[property="og:site_name"]').attr('content')?.trim(),
      ogDescription: $('meta[property="og:description"]').attr('content')?.trim(),
    };
  }

  private resolveBrandName(
    meta: { title?: string; ogTitle?: string; ogSiteName?: string },
    domain: string,
  ): string {
    if (meta.ogSiteName && meta.ogSiteName.length > 1) return meta.ogSiteName;
    if (meta.ogTitle && meta.ogTitle.length > 1) {
      const parts = meta.ogTitle.split(/[|–—-]/);
      return (parts.at(-1) ?? parts[0]).trim();
    }
    if (meta.title && meta.title.length > 1) {
      const parts = meta.title.split(/[|–—-]/);
      return (parts.at(-1) ?? parts[0]).trim();
    }
    return this.extractDomainName(domain);
  }

  private extractDomainName(urlOrDomain: string): string {
    const domain = urlOrDomain.replace(/https?:\/\//, '').split('/')[0];
    return domain
      .split('.')[0]
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // -------------------------------------------------------------------------
  // Search for new Shopify brands
  // -------------------------------------------------------------------------

  async discoverNewBrands(): Promise<{ discovered: number; added: number }> {
    const searchQueries = [
      // ─── Toys & Games (11) ───────────────────────────────────────────────
      { query: 'toys site:myshopify.com', category: 'toys_games' },
      { query: 'educational toys site:myshopify.com', category: 'toys_games' },
      { query: 'STEM toys site:myshopify.com', category: 'toys_games' },
      { query: 'building blocks site:myshopify.com', category: 'toys_games' },
      { query: 'board games site:myshopify.com', category: 'toys_games' },
      { query: 'puzzle games site:myshopify.com', category: 'toys_games' },
      { query: 'learning kits site:myshopify.com', category: 'toys_games' },
      { query: 'science kits site:myshopify.com', category: 'toys_games' },
      { query: 'art supplies site:myshopify.com', category: 'toys_games' },
      { query: 'craft kits site:myshopify.com', category: 'toys_games' },
      { query: 'wooden toys site:myshopify.com', category: 'toys_games' },

      // ─── Food & Beverage (15) ────────────────────────────────────────────
      { query: 'organic snacks site:myshopify.com', category: 'food_beverage' },
      { query: 'plant-based food site:myshopify.com', category: 'food_beverage' },
      { query: 'craft coffee site:myshopify.com', category: 'food_beverage' },
      { query: 'specialty tea site:myshopify.com', category: 'food_beverage' },
      { query: 'artisan chocolate site:myshopify.com', category: 'food_beverage' },
      { query: 'energy drinks site:myshopify.com', category: 'food_beverage' },
      { query: 'kombucha site:myshopify.com', category: 'food_beverage' },
      { query: 'beef jerky site:myshopify.com', category: 'food_beverage' },
      { query: 'nut butter site:myshopify.com', category: 'food_beverage' },
      { query: 'gourmet spices site:myshopify.com', category: 'food_beverage' },
      { query: 'specialty sauces site:myshopify.com', category: 'food_beverage' },
      { query: 'gluten-free snacks site:myshopify.com', category: 'food_beverage' },
      { query: 'vegan cheese site:myshopify.com', category: 'food_beverage' },
      { query: 'premium granola site:myshopify.com', category: 'food_beverage' },
      { query: 'protein bars site:myshopify.com', category: 'food_beverage' },

      // ─── Supplements & Wellness (11) ─────────────────────────────────────
      { query: 'collagen powder site:myshopify.com', category: 'supplements' },
      { query: 'protein powder site:myshopify.com', category: 'supplements' },
      { query: 'CBD products site:myshopify.com', category: 'supplements' },
      { query: 'nootropics site:myshopify.com', category: 'supplements' },
      { query: 'superfoods site:myshopify.com', category: 'supplements' },
      { query: 'probiotics site:myshopify.com', category: 'supplements' },
      { query: 'omega-3 supplements site:myshopify.com', category: 'supplements' },
      { query: 'adaptogens site:myshopify.com', category: 'supplements' },
      { query: 'multivitamins site:myshopify.com', category: 'supplements' },
      { query: 'vitamin D supplements site:myshopify.com', category: 'supplements' },
      { query: 'wellness products site:myshopify.com', category: 'supplements' },

      // ─── Cosmetics & Personal Care (11) ──────────────────────────────────
      { query: 'natural skincare site:myshopify.com', category: 'cosmetics_personal_care' },
      { query: 'vegan cosmetics site:myshopify.com', category: 'cosmetics_personal_care' },
      { query: 'organic beauty site:myshopify.com', category: 'cosmetics_personal_care' },
      { query: 'K-beauty site:myshopify.com', category: 'cosmetics_personal_care' },
      { query: 'clean beauty site:myshopify.com', category: 'cosmetics_personal_care' },
      { query: 'essential oils site:myshopify.com', category: 'cosmetics_personal_care' },
      { query: 'natural deodorant site:myshopify.com', category: 'cosmetics_personal_care' },
      { query: 'organic shampoo site:myshopify.com', category: 'cosmetics_personal_care' },
      { query: 'luxury skincare site:myshopify.com', category: 'cosmetics_personal_care' },
      { query: 'lip balm site:myshopify.com', category: 'cosmetics_personal_care' },
      { query: 'natural cosmetics site:myshopify.com', category: 'cosmetics_personal_care' },

      // ─── Home & Lifestyle (9) ────────────────────────────────────────────
      { query: 'sustainable home site:myshopify.com', category: 'home_goods' },
      { query: 'eco-friendly bedding site:myshopify.com', category: 'home_goods' },
      { query: 'luxury linens site:myshopify.com', category: 'home_goods' },
      { query: 'home decor site:myshopify.com', category: 'home_goods' },
      { query: 'kitchen gadgets site:myshopify.com', category: 'home_goods' },
      { query: 'smart home site:myshopify.com', category: 'home_goods' },
      { query: 'furniture site:myshopify.com', category: 'home_goods' },
      { query: 'home organization site:myshopify.com', category: 'home_goods' },
      { query: 'sustainable products site:myshopify.com', category: 'home_goods' },
    ];

    let discovered = 0;
    let added = 0;
    let browser: Browser | undefined;

    try {
      browser = await this.launchStealthBrowser();

      for (const { query, category } of searchQueries) {
        try {
          const domains = await this.searchShopifyStores(browser, query);
          discovered += domains.length;

          for (const domain of domains) {
            const wasAdded = await this.addCandidateBrand(domain, category);
            if (wasAdded) added++;
          }

          logger.info(
            { query, found: domains.length, category },
            'Search discovery results',
          );

          // Heavy rate limiting with jitter between search queries
          const baseDelay = 5000;
          const jitter = Math.floor(Math.random() * 2000);
          await this.sleep(baseDelay + jitter);
        } catch (err) {
          logger.warn({ query, error: (err as Error).message }, 'Search failed');
        }
      }
    } finally {
      await browser?.close();
    }

    return { discovered, added };
  }

  // -------------------------------------------------------------------------
  // Search engines — tries Bing first, falls back to Google
  // -------------------------------------------------------------------------

  private async searchShopifyStores(browser: Browser, searchQuery: string): Promise<string[]> {
    try {
      const domains = await this.searchBing(browser, searchQuery);
      if (domains.length > 0) return domains;
      logger.debug({ query: searchQuery }, 'Bing returned 0 results — trying Google');
    } catch (err) {
      logger.warn({ query: searchQuery, error: (err as Error).message }, 'Bing search failed — trying Google');
    }

    try {
      return await this.searchGoogle(browser, searchQuery);
    } catch (err) {
      logger.warn({ query: searchQuery, error: (err as Error).message }, 'Google search also failed');
      return [];
    }
  }

  private async searchBing(browser: Browser, searchQuery: string): Promise<string[]> {
    const context = await this.getStealthContext(browser);
    const page = await context.newPage();

    await page.route('**/*', (route: Route) => {
      const type = route.request().resourceType();
      if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
        void route.abort();
      } else {
        void route.continue();
      }
    });

    try {
      const url = `https://www.bing.com/search?q=${encodeURIComponent(searchQuery)}&count=20&setlang=en`;
      logger.debug({ url }, 'Searching Bing for Shopify stores');

      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });

      if (!response || response.status() !== 200) {
        logger.warn({ status: response?.status() }, 'Bing returned non-200 status');
        return [];
      }

      // Handle cookie consent / interstitial
      await this.handleInterstitial(page);

      await this.sleep(1500 + Math.floor(Math.random() * 1000));

      const html = await page.content();
      const $ = cheerio.load(html);

      const domains = new Set<string>();

      // Primary: main organic result links
      $('#b_results li.b_algo h2 a, #b_results li.b_algo .b_title h2 a').each((_, el) => {
        const href = $(el).attr('href');
        if (!href) return;
        try {
          const hostname = new URL(href).hostname.toLowerCase();
          if (this.isShopifyDomain(hostname)) domains.add(hostname);
        } catch { /* skip malformed */ }
      });

      // Secondary: cite elements
      $('#b_results li.b_algo cite, #b_results .b_attribution cite').each((_, el) => {
        const text = $(el).text().trim().toLowerCase();
        const match = text.match(/([a-z0-9-]+\.myshopify\.com)/);
        if (match) domains.add(match[1]);
      });

      // Tertiary: any myshopify link
      if (domains.size === 0) {
        $('#b_results a[href*="myshopify.com"], #b_results a[href*="shopify.com"]').each((_, el) => {
          const href = $(el).attr('href');
          if (!href) return;
          try {
            const hostname = new URL(href).hostname.toLowerCase();
            if (this.isShopifyDomain(hostname)) domains.add(hostname);
          } catch { /* skip */ }
        });
      }

      logger.debug({ query: searchQuery, found: domains.size }, 'Bing search results');
      return [...domains];
    } finally {
      await page.close();
      await context.close();
    }
  }

  private async searchGoogle(browser: Browser, searchQuery: string): Promise<string[]> {
    const context = await this.getStealthContext(browser);
    const page = await context.newPage();

    await page.route('**/*', (route: Route) => {
      const type = route.request().resourceType();
      if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
        void route.abort();
      } else {
        void route.continue();
      }
    });

    try {
      const url = `https://www.google.com/search?q=${encodeURIComponent(searchQuery)}&num=20&hl=en`;
      logger.debug({ url }, 'Searching Google for Shopify stores');

      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });

      if (!response || response.status() !== 200) {
        logger.warn({ status: response?.status() }, 'Google returned non-200 status');
        return [];
      }

      // Handle cookie consent / interstitial / CAPTCHA indicators
      await this.handleInterstitial(page);

      await this.sleep(2000 + Math.floor(Math.random() * 1000));

      const html = await page.content();
      const $ = cheerio.load(html);

      // Detect CAPTCHA / blocking page
      if (html.includes('unusual traffic') || html.includes('captcha') || html.includes('CAPTCHA')) {
        logger.warn('Google detected bot — CAPTCHA or unusual traffic page');
        return [];
      }

      const domains = new Set<string>();

      const linkSelectors = [
        'a[jsname="UWckNb"]',
        '#rso .g a[href^="http"]:not([href*="google"])',
        '#search a[href^="http"]:not([href*="google.com"])',
        'h3[class] + a[href^="http"], h3[class] + * a[href^="http"]',
        'a[ping][href^="http"]',
      ];

      for (const sel of linkSelectors) {
        $(sel).each((_, el) => {
          const href = $(el).attr('href');
          if (!href) return;
          try {
            const hostname = new URL(href).hostname.toLowerCase();
            if (this.isShopifyDomain(hostname)) domains.add(hostname);
          } catch { /* skip */ }
        });
        if (domains.size > 0) break;
      }

      // Cite fallback
      $('cite').each((_, el) => {
        const text = $(el).text().trim().toLowerCase();
        const match = text.match(/([a-z0-9-]+\.myshopify\.com)/);
        if (match) domains.add(match[1]);
      });

      logger.debug({ query: searchQuery, found: domains.size }, 'Google search results');
      return [...domains];
    } finally {
      await page.close();
      await context.close();
    }
  }

  // -------------------------------------------------------------------------
  // Interstitial / cookie consent handler
  // -------------------------------------------------------------------------

  private async handleInterstitial(page: Page): Promise<void> {
    try {
      // Common cookie consent button selectors
      const consentSelectors = [
        'button[aria-label*="Accept"]',
        'button:has-text("Accept")',
        'button:has-text("I agree")',
        'button:has-text("Allow")',
        'button:has-text("Continue")',
        '[id*="consent"] button',
        '[class*="consent"] button',
        'form[action*="consent"] button',
      ];

      for (const selector of consentSelectors) {
        const button = page.locator(selector).first();
        if (await button.isVisible({ timeout: 2000 }).catch(() => false)) {
          await button.click();
          await this.sleep(1000);
          break;
        }
      }
    } catch {
      // No interstitial found — continue
    }
  }

  private isShopifyDomain(hostname: string): boolean {
    return hostname.includes('myshopify.com') && !hostname.startsWith('www.myshopify.com');
  }

  // -------------------------------------------------------------------------
  // Database seeding
  // -------------------------------------------------------------------------

  private async seedDatabaseBrands(): Promise<void> {
    let seeded = 0;
    for (const seed of SEED_BRANDS) {
      const added = await this.addCandidateBrand(seed.domain, seed.expectedCategories[0] ?? 'general');
      if (added) seeded++;
    }
    if (seeded > 0) {
      logger.info({ seeded }, 'Shopify crawler: inserted missing seed brands into DB');
    }
  }

  // -------------------------------------------------------------------------
  // Add candidate brand
  // -------------------------------------------------------------------------

  private async addCandidateBrand(domain: string, category: string): Promise<boolean> {
    const normalizedDomain = domain.replace(/^www\./, '');
    const websiteUrl = `https://${normalizedDomain}`;

    const sameUrl = await db
      .select({ id: brands.id })
      .from(brands)
      .where(eq(brands.websiteUrl, websiteUrl))
      .limit(1);

    if (sameUrl.length > 0) {
      return false;
    }

    try {
      const inserted = await db
        .insert(brands)
        .values({
          name: normalizedDomain.split('.')[0].replace(/-/g, ' ').toUpperCase(),
          websiteUrl,
          categories: [category],
          euPresence: false,
          country: 'US',
        })
        .onConflictDoNothing()
        .returning({ id: brands.id });

      if (inserted.length === 0) {
        return false;
      }

      logger.info({ domain: normalizedDomain, category }, 'Candidate brand added');
      return true;
    } catch (err) {
      logger.warn({ domain: normalizedDomain, error: (err as Error).message }, 'Failed to add candidate');
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Database write with status tracking
  // -------------------------------------------------------------------------

  private async upsertBrand(
    metadata: BrandMetadata,
    item: { websiteUrl: string; segment?: string },
  ): Promise<{ wasInserted: boolean }> {
    const existing = await db
      .select({ id: brands.id })
      .from(brands)
      .where(eq(brands.websiteUrl, metadata.websiteUrl))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(brands)
        .set({
          categories: metadata.categories,
          shopifyStoreUrl: metadata.shopifyStoreUrl,
          updatedAt: new Date(),
          // Note: status/segment fields would need to be added to schema
          // For now, we store in categories as composite signal
        })
        .where(eq(brands.id, existing[0].id));
      return { wasInserted: false };
    }

    const returning = await db
      .insert(brands)
      .values({
        name: metadata.name,
        websiteUrl: metadata.websiteUrl,
        shopifyStoreUrl: metadata.shopifyStoreUrl,
        categories: metadata.categories,
        country: null,
        euPresence: false,
      })
      .onConflictDoNothing()
      .returning({ id: brands.id });

    const inserted = returning[0];
    if (!inserted) return { wasInserted: false };

    // Insert a minimal catalog marker so the scoring engine knows product count > 0.
    // Guard against duplicates: products table has no unique constraint, so we check first.
    if (metadata.isShopify && metadata.productCount > 0) {
      const existingProduct = await db
        .select({ id: products.id })
        .from(products)
        .where(eq(products.brandId, inserted.id))
        .limit(1);

      if (existingProduct.length === 0) {
        await db.insert(products).values({
          brandId: inserted.id,
          name: `${metadata.name} — Catalog Reference`,
          categoryPath: item.segment ?? metadata.segment ?? metadata.categories[0] ?? 'general',
        });
      }
    }

    return { wasInserted: true };
  }
}
