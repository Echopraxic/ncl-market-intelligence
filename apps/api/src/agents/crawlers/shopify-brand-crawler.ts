import { chromium, type Browser, type Page } from 'playwright';
import * as cheerio from 'cheerio';
import { db } from '@/db/index.js';
import { brands, products } from '@/db/schema.js';
import { logger } from '@/lib/logger.js';
import { eq } from 'drizzle-orm';
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
      browser = await chromium.launch({ headless: true });

      for (const seed of SEED_BRANDS) {
        try {
          await this.sleep(this.rateLimitMs);

          const metadata = await this.withRetry(
            () => this.scrapeStore(browser!, seed),
            `scrape:${seed.domain}`,
          );

          if (!metadata) {
            logger.warn({ domain: seed.domain }, 'Could not extract brand metadata — skipping');
            const netError: StructuredCrawlError = {
              code: CrawlErrorCode.NETWORK_ERROR,
              domain: seed.domain,
              message: 'Could not extract brand metadata',
              retryable: true,
              timestamp: new Date().toISOString(),
            };
            structuredErrors.push(netError);
            continue;
          }

          const { wasInserted } = await this.upsertBrand(metadata, seed);
          recordsFound++;
          if (wasInserted) newRecordsFound++;
          pagesScraped++;

          logger.info(
            { domain: seed.domain, brand: metadata.name, isShopify: metadata.isShopify, wasInserted },
            'Brand scraped and upserted',
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error({ domain: seed.domain, error: msg }, 'Failed to scrape brand');
          const errorCode = classifyError(msg);
          const structError: StructuredCrawlError = {
            code: errorCode,
            domain: seed.domain,
            message: msg,
            retryable: [CrawlErrorCode.TIMEOUT, CrawlErrorCode.NETWORK_ERROR].includes(errorCode),
            timestamp: new Date().toISOString(),
          };
          structuredErrors.push(structError);
          errors.push(`${seed.domain}: ${msg}`);
        }
      }
    } finally {
      await browser?.close();
    }

    return { crawlerType: this.crawlerType, recordsFound, newRecordsFound, pagesScraped, errors, structuredErrors };
  }

  // -------------------------------------------------------------------------
  // Scrape a single Shopify store
  // -------------------------------------------------------------------------

  private async scrapeStore(browser: Browser, seed: SeedEntry): Promise<BrandMetadata | null> {
    const baseUrl = `https://${seed.domain}`;
    const log = logger.child({ domain: seed.domain });
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

      // Hit Shopify's products.json endpoint (public, no auth needed) for
      // product count and category hints. Gracefully handles non-Shopify sites.
      const { productCount, productCategories } = await this.fetchShopifyProducts(page, seed.domain);

      const name = this.resolveBrandName(metaTags, seed.domain);

      // Merge seed expected categories with anything extracted from the store
      const categories = this.mergeCategories(seed.expectedCategories, productCategories);

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
  // Database write
  // -------------------------------------------------------------------------

  private async upsertBrand(metadata: BrandMetadata, seed: SeedEntry): Promise<{ wasInserted: boolean }> {
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

    // Insert brand
    const [inserted] = await db
      .insert(brands)
      .values({
        name: metadata.name,
        websiteUrl: metadata.websiteUrl,
        shopifyStoreUrl: metadata.shopifyStoreUrl,
        categories: metadata.categories,
        country: 'US',
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
        categoryPath: seed.expectedCategories[0] ?? seed.segment,
      }).onConflictDoNothing();
    }

    return { wasInserted: true };
  }
}
