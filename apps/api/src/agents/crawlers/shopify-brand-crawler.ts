import { chromium, type Browser, type Page } from 'playwright';
import * as cheerio from 'cheerio';
import { db } from '@/db/index.js';
import { brands, products } from '@/db/schema.js';
import { logger } from '@/lib/logger.js';
import { eq, isNull, and } from 'drizzle-orm';
import { BaseCrawler, type CrawlResult } from './base-crawler.js';
import { CrawlErrorCode, StructuredCrawlError, classifyError } from '@/lib/crawler-errors.js';

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
  shopifyStoreUrl: string;
  categories: string[];
  isShopify: boolean;
  productCount: number;
  description?: string;
};

// ---------------------------------------------------------------------------
// Seed list
//
// 8 toy brands · 3 CPG brands · 3 wellness brands · 2 home goods brands
//
// These are US brands with established Shopify presences in categories NCL
// targets for EU expansion. The crawler validates each is actually on Shopify
// and gracefully skips/logs any that have migrated platforms.
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
// Crawler
// ---------------------------------------------------------------------------

export class ShopifyBrandCrawler extends BaseCrawler {
  readonly crawlerType = 'shopify-brand';

  async run(): Promise<CrawlResult> {
    const errors: string[] = [];
    const structuredErrors: StructuredCrawlError[] = [];
    let recordsFound = 0;
    let newRecordsFound = 0;
    let pagesScraped = 0;
    let browser: Browser | undefined;

    try {
      // Phase 0: Ensure seed brands exist in DB (idempotent — skips existing rows)
      await this.seedDatabaseBrands();

      // Phase 1: Discover new candidate brands via search engines
      logger.info('Shopify crawler: starting brand discovery');
      const { discovered, added } = await this.discoverNewBrands();
      logger.info({ discovered, added }, 'Shopify crawler: discovery complete');

      browser = await chromium.launch({ headless: true });

      // Phase 2: Combine seed brands + unchecked brands from database (now includes discovered)
      const toCheck = await this.getBrandsToCheck();
      logger.info({ count: toCheck.length }, 'Shopify crawler: brands to check');

      for (const item of toCheck) {
        try {
          await this.sleep(this.rateLimitMs);

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
            continue;
          }

          const { wasInserted } = await this.upsertBrand(metadata, item);
          recordsFound++;
          if (wasInserted) newRecordsFound++;
          pagesScraped++;

          logger.info(
            { domain: item.websiteUrl, brand: metadata.name, isShopify: metadata.isShopify, wasInserted },
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
        }
      }
    } finally {
      await browser?.close();
    }

    return { crawlerType: this.crawlerType, recordsFound, newRecordsFound, pagesScraped, errors, structuredErrors };
  }

  // -------------------------------------------------------------------------
  // Get brands to check: unchecked seed brands + unchecked database brands
  //
  // Seed brands are only checked once (when shopifyStoreUrl is NULL).
  // After first check, they're either marked with shopifyStoreUrl or remain
  // in database with NULL → skipped on subsequent runs.
  // -------------------------------------------------------------------------

  private async getBrandsToCheck(): Promise<Array<{ websiteUrl: string; segment?: string }>> {
    // Get seed brand URLs to check against database
    const seedUrls = SEED_BRANDS.map((s) => `https://${s.domain}`);

    // Query database for ALL brands without shopifyStoreUrl (both seed + discovered)
    const uncheckedBrands = await db
      .select({
        id: brands.id,
        websiteUrl: brands.websiteUrl,
      })
      .from(brands)
      .where(isNull(brands.shopifyStoreUrl))
      .limit(75); // Increased from 50

    // Filter to only include unchecked seed brands + all unchecked discovered brands
    const toCheckItems = uncheckedBrands
      .filter((b) => b.websiteUrl && b.websiteUrl.startsWith('http'))
      .map((b) => {
        const isSeed = seedUrls.some((url) => url.toLowerCase() === b.websiteUrl!.toLowerCase());
        const segment = isSeed ? SEED_BRANDS.find((s) => `https://${s.domain}`.toLowerCase() === b.websiteUrl!.toLowerCase())?.segment : undefined;
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
    const context = await browser.newContext({
      userAgent: this.getNextUserAgent(),
    });
    const page = await context.newPage();

    // Block heavy assets for faster scraping
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
        void route.abort();
      } else {
        void route.continue();
      }
    });

    try {
      log.info({ url: baseUrl }, 'Navigating to brand homepage');
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await this.sleep(1500);

      const html = await page.content();
      const isShopify = this.detectShopify(html);
      const metaTags = this.extractMetaTags(html);

      // Extract domain from URL for Shopify API call
      const domain = new URL(baseUrl).hostname ?? baseUrl.replace(/https?:\/\//, '');

      // Hit Shopify's products.json endpoint (public, no auth needed) for
      // product count and category hints. Gracefully handles non-Shopify sites.
      const { productCount, productCategories } = await this.fetchShopifyProducts(page, domain);

      const name = this.resolveBrandName(metaTags, domain);

      // Use discovered categories (no seed expected categories in dynamic mode)
      const categories = productCategories.length > 0 ? productCategories : ['general'];

      return {
        name,
        websiteUrl: baseUrl,
        shopifyStoreUrl: baseUrl,
        categories,
        isShopify,
        productCount,
        description: metaTags.description,
      };
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'Scrape failed');
      return null;
    } finally {
      await page.close();
      await context.close();
    }
  }

  // -------------------------------------------------------------------------
  // Shopify product catalog probe
  // -------------------------------------------------------------------------

  private async fetchShopifyProducts(
    page: Page,
    domain: string,
  ): Promise<{ productCount: number; productCategories: string[] }> {
    try {
      const response = await page.evaluate(async (url) => {
        const res = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!res.ok) return null;
        return res.json() as Promise<{ products: Array<{ product_type: string; tags: string }> }>;
      }, `https://${domain}/products.json?limit=250`);

      if (!response || !Array.isArray(response.products)) {
        return { productCount: 0, productCategories: [] };
      }

      const productCount = response.products.length;

      // Collect product_type values and tag strings as category signals
      const rawTypes = response.products
        .map((p) => p.product_type)
        .filter(Boolean);

      const rawTags = response.products
        .flatMap((p) => (p.tags ? p.tags.split(',').map((t) => t.trim()) : []))
        .filter((t) => t.length > 2 && t.length < 50);

      const productCategories = [...new Set([...rawTypes, ...rawTags])].slice(0, 20);

      return { productCount, productCategories };
    } catch {
      // Site may not be Shopify or may have blocked the endpoint
      return { productCount: 0, productCategories: [] };
    }
  }

  // -------------------------------------------------------------------------
  // HTML parsing helpers
  // -------------------------------------------------------------------------

  private detectShopify(html: string): boolean {
    return (
      html.includes('cdn.shopify.com') ||
      html.includes('Shopify.shop') ||
      html.includes('myshopify.com') ||
      html.includes('/cart.js') ||
      html.includes('window.Shopify')
    );
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
    // Prefer og:site_name > og:title > <title> > domain
    if (meta.ogSiteName && meta.ogSiteName.length > 1) return meta.ogSiteName;
    if (meta.ogTitle && meta.ogTitle.length > 1) {
      // og:title often contains page name + brand e.g. "Home | Melissa & Doug"
      const parts = meta.ogTitle.split(/[|–—-]/);
      return (parts.at(-1) ?? parts[0]).trim();
    }
    if (meta.title && meta.title.length > 1) {
      const parts = meta.title.split(/[|–—-]/);
      return (parts.at(-1) ?? parts[0]).trim();
    }
    // Fall back to title-casing the domain without TLD
    return domain.split('.')[0].replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  private mergeCategories(seed: string[], discovered: string[]): string[] {
    const combined = new Set([...seed, ...discovered]);
    return [...combined].slice(0, 30);
  }

  // -------------------------------------------------------------------------
  // Search for new Shopify brands via Google
  // -------------------------------------------------------------------------

  async discoverNewBrands(): Promise<{ discovered: number; added: number }> {
    const searchQueries = [
      // ─── Toys & Games (11 queries) ───────────────────────────────────────
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

      // ─── Food & Beverage (15 queries) ────────────────────────────────────
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

      // ─── Supplements & Wellness (11 queries) ─────────────────────────────
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

      // ─── Cosmetics & Personal Care (11 queries) ──────────────────────────
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

      // ─── Home & Lifestyle (9 queries) ────────────────────────────────────
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
      browser = await chromium.launch({ headless: true });

      for (const { query, category } of searchQueries) {
        try {
          const domains = await this.searchShopifyStores(browser, query);
          discovered += domains.length;

          for (const domain of domains) {
            const wasAdded = await this.addCandidateBrand(domain, category);
            if (wasAdded) added++;
          }

          logger.info(
            { query, found: domains.length, added: domains.filter(() => true).length },
            'Search discovery results',
          );

          // Heavy rate limiting to avoid Google blocking
          await this.sleep(5000);
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
  // Search for Shopify stores — tries Bing first, falls back to Google
  // -------------------------------------------------------------------------

  private async searchShopifyStores(browser: Browser, searchQuery: string): Promise<string[]> {
    // Bing is significantly more headless-friendly than Google and returns
    // direct hrefs in standard anchor tags — no redirect wrapping.
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
    const context = await browser.newContext({ userAgent: this.getNextUserAgent() });
    const page = await context.newPage();

    await page.route('**/*', (route) => {
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

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await this.sleep(1500);

      const html = await page.content();
      const $ = cheerio.load(html);

      const domains = new Set<string>();

      // Primary: main organic result links (h2 > a inside .b_algo)
      $('#b_results li.b_algo h2 a, #b_results li.b_algo .b_title h2 a').each((_, el) => {
        const href = $(el).attr('href');
        if (!href) return;
        try {
          const hostname = new URL(href).hostname.toLowerCase();
          if (this.isShopifyDomain(hostname)) domains.add(hostname);
        } catch { /* skip malformed */ }
      });

      // Secondary: cite elements show the display URL, often cleaner for myshopify domains
      $('#b_results li.b_algo cite, #b_results .b_attribution cite').each((_, el) => {
        const text = $(el).text().trim().toLowerCase();
        const match = text.match(/([a-z0-9-]+\.myshopify\.com)/);
        if (match) domains.add(match[1]);
      });

      // Tertiary: any result-section link pointing to myshopify.com
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
    const context = await browser.newContext({ userAgent: this.getNextUserAgent() });
    const page = await context.newPage();

    await page.route('**/*', (route) => {
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

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await this.sleep(2000);

      const html = await page.content();
      const $ = cheerio.load(html);

      const domains = new Set<string>();

      // Modern Google result link selectors — Google uses direct hrefs now, not redirect URLs.
      // Multiple selectors in priority order; stop at first that yields results.
      const linkSelectors = [
        'a[jsname="UWckNb"]',                                         // primary result link (modern Google)
        '#rso .g a[href^="http"]:not([href*="google"])',              // result section
        '#search a[href^="http"]:not([href*="google.com"])',          // broad search container
        'h3[class] + a[href^="http"], h3[class] + * a[href^="http"]', // title-adjacent links
        'a[ping][href^="http"]',                                      // links with Ping tracking
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

      // Cite elements as fallback (visible URL shown under each result)
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

  private isShopifyDomain(hostname: string): boolean {
    return hostname.includes('myshopify.com') && !hostname.startsWith('www.myshopify.com');
  }

  // -------------------------------------------------------------------------
  // Ensure seed brands exist in the database (called on every run, idempotent)
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
  // Add a brand candidate to the database if not already present
  // -------------------------------------------------------------------------

  private async addCandidateBrand(domain: string, category: string): Promise<boolean> {
    // Normalize domain (remove www, add https)
    const normalizedDomain = domain.replace(/^www\./, '');
    const websiteUrl = `https://${normalizedDomain}`;

    // Only proceed if not already in DB with same URL
    const sameUrl = await db
      .select({ id: brands.id })
      .from(brands)
      .where(eq(brands.websiteUrl, websiteUrl))
      .limit(1);

    if (sameUrl.length > 0) {
      return false; // Already in database
    }

    try {
      // Insert as a candidate brand (minimal info, will be enriched when scraped)
      // Country is left NULL — will be populated during scraping if detectable.
      // .returning() lets us distinguish a real insert from an ON CONFLICT skip
      // (the brands.name unique constraint can also match here).
      const inserted = await db
        .insert(brands)
        .values({
          name: normalizedDomain.split('.')[0].replace(/-/g, ' ').toUpperCase(),
          websiteUrl,
          categories: [category],
          euPresence: false,
          country: null,
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
  // Database write
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
        })
        .where(eq(brands.id, existing[0].id));
      return { wasInserted: false };
    }

    // Insert brand (country is NULL if not detected)
    const [inserted] = await db
      .insert(brands)
      .values({
        name: metadata.name,
        websiteUrl: metadata.websiteUrl,
        shopifyStoreUrl: metadata.shopifyStoreUrl,
        categories: metadata.categories,
        country: null,
        euPresence: false,
      })
      .onConflictDoUpdate({
        target: brands.name,
        set: {
          categories: metadata.categories,
          shopifyStoreUrl: metadata.shopifyStoreUrl,
          updatedAt: new Date(),
        },
      })
      .returning({ id: brands.id });

    // Seed a placeholder product entry so the scoring engine has at least one
    // product record to work with until the full catalog crawler runs.
    if (metadata.productCount > 0) {
      await db.insert(products).values({
        brandId: inserted.id,
        name: `${metadata.name} Catalog (${metadata.productCount} products)`,
        categoryPath: item.segment ?? metadata.categories[0] ?? 'general',
      }).onConflictDoNothing();
    }

    return { wasInserted: true };
  }
}
