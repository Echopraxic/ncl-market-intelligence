import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
import type { Browser, Page } from 'playwright';
import { db } from '@/db/index.js';
import {
  leads, distributors, distributorBrandMatches, distributorBrandPortfolio, agentOutputs,
} from '@/db/schema.js';
import { logger } from '@/lib/logger.js';
import { eq, and, gt, isNotNull, inArray, sql } from 'drizzle-orm';
import { classifySubCategory, topLevelCategory, SUBCATEGORY_MAP } from '@/config/subcategory-map.js';

chromium.use(StealthPlugin());

const RATE_LIMIT_MS  = 4000;
const MAX_LEAD_SCRAPES      = 25; // Strategy A forward: brand → distributor pages
const MAX_DIST_SCRAPES      = 30; // Strategy C: distributor → brand portfolio pages
const MIN_LEAD_QUALITY      = 70;
const MIN_DIST_SCORE        = 40;
const EXACT_SCORE_FACTOR    = 0.85;
const ADJACENT_SCORE_BONUS  = 1.05;

// Patterns that suggest a "where to buy" page on a brand's website
const WHERE_TO_BUY_PATTERNS = [
  'distributor', 'stockist', 'where to buy', 'find us', 'retailers',
  'wholesale', 'partner', 'reseller', 'shop locator', 'store finder',
];

// Patterns that suggest a brand portfolio page on a distributor's website
const PORTFOLIO_PATTERNS = [
  'brands', 'portfolio', 'our-brands', 'marken', 'partners',
  'producers', 'suppliers', 'range', 'products/brands',
];

type IntelResult = {
  subCategorised:   number;
  portfolioEntries: number;
  matchesUpdated:   number;
};

export class CompetitorIntelligenceAgent {
  private browser: Browser | null = null;

  async run(): Promise<IntelResult> {
    const result: IntelResult = { subCategorised: 0, portfolioEntries: 0, matchesUpdated: 0 };

    try {
      this.browser = await chromium.launch({ headless: true });

      // Stage 1: classify leads into sub-categories
      result.subCategorised = await this.classifyLeadSubCategories();

      // Stage 2: collect portfolio intelligence (3 strategies)
      result.portfolioEntries += await this.strategyA_BrandWebsites();
      result.portfolioEntries += await this.strategyB_FaireBulletin();
      result.portfolioEntries += await this.strategyC_DistributorWebsites();

      // Stage 3: apply competitor proximity flags + adjust scores
      result.matchesUpdated = await this.applyProximityFlags();

    } finally {
      await this.browser?.close().catch(() => undefined);
    }

    logger.info(result, '[CompetitorIntel] completed');
    return result;
  }

  // ---------------------------------------------------------------------------
  // Stage 1 — sub-category classification from existing product title data
  // ---------------------------------------------------------------------------

  private async classifyLeadSubCategories(): Promise<number> {
    const unclassified = await db
      .select({ id: leads.id, companyName: leads.companyName, websiteUrl: leads.websiteUrl })
      .from(leads)
      .where(and(
        sql`${leads.subCategory} IS NULL`,
        gt(leads.leadQualityScore, MIN_LEAD_QUALITY),
      ));

    let classified = 0;

    for (const lead of unclassified) {
      const tokens = await this.extractProductTokens(lead.companyName, lead.websiteUrl);
      if (tokens.length === 0) continue;

      const subCat = classifySubCategory(tokens);
      if (!subCat) continue;

      await db.update(leads)
        .set({ subCategory: subCat, updatedAt: new Date() })
        .where(eq(leads.id, lead.id));

      classified++;
    }

    return classified;
  }

  /** Collect product title tokens for a lead from agentOutputs. */
  private async extractProductTokens(companyName: string, websiteUrl: string | null): Promise<string[]> {
    try {
      const rows = await db
        .select({ raw: agentOutputs.outputData })
        .from(agentOutputs)
        .where(inArray(agentOutputs.agentType, ['shopify-brand', 'faire', 'bulletin', 'product-hunt']))
        .limit(20);

      const tokens: string[] = [];
      const nameLower = companyName.toLowerCase();
      const urlLower  = (websiteUrl ?? '').toLowerCase();

      for (const row of rows) {
        const raw = row.raw as Record<string, unknown> | null;
        if (!raw) continue;

        // Check if this output relates to our lead
        const rawStr = JSON.stringify(raw).toLowerCase();
        if (!rawStr.includes(nameLower) && !rawStr.includes(urlLower)) continue;

        // Extract product titles / names from common output shapes
        const candidates: string[] = [];
        if (Array.isArray(raw['productTitles'])) candidates.push(...(raw['productTitles'] as string[]));
        if (Array.isArray(raw['products'])) candidates.push(...(raw['products'] as { name?: string }[]).map(p => p.name ?? ''));
        if (Array.isArray(raw['categories'])) candidates.push(...(raw['categories'] as string[]).filter(c => typeof c === 'string'));
        if (typeof raw['description'] === 'string') candidates.push(raw['description']);

        for (const t of candidates) {
          tokens.push(...t.toLowerCase().split(/[\s,/]+/).filter((w: string) => w.length > 2));
        }
      }

      return tokens;
    } catch {
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Stage 2A — brand website "where to buy" scraping (both directions)
  //
  // Forward:  for each lead, find which distributors carry them in EU
  // Reverse:  for each distributor, find which of their portfolio brands
  //           already have EU distributor pages → expand portfolio coverage
  // ---------------------------------------------------------------------------

  private async strategyA_BrandWebsites(): Promise<number> {
    if (!this.browser) return 0;

    // Forward pass: leads → their EU distributors
    const targetLeads = await db
      .select({ id: leads.id, companyName: leads.companyName, websiteUrl: leads.websiteUrl, bestCategory: leads.bestCategory, subCategory: leads.subCategory })
      .from(leads)
      .where(and(
        isNotNull(leads.websiteUrl),
        gt(leads.leadQualityScore, MIN_LEAD_QUALITY),
      ))
      .limit(MAX_LEAD_SCRAPES);

    // Reverse pass: known distributor portfolio brands that have websiteUrls
    const portfolioBrands = await db
      .select({
        distributorId: distributorBrandPortfolio.distributorId,
        brandName:     distributorBrandPortfolio.brandName,
        brandWebsiteUrl: distributorBrandPortfolio.brandWebsiteUrl,
        subCategoryHint: distributorBrandPortfolio.subCategoryHint,
      })
      .from(distributorBrandPortfolio)
      .where(isNotNull(distributorBrandPortfolio.brandWebsiteUrl))
      .limit(MAX_LEAD_SCRAPES);

    let inserted = 0;

    // Forward
    for (const lead of targetLeads) {
      if (!lead.websiteUrl) continue;
      const distributorNames = await this.scrapeWhereToBuy(lead.websiteUrl);
      inserted += await this.resolveAndInsertPortfolio(
        distributorNames,
        lead.companyName,
        lead.websiteUrl,
        lead.bestCategory,
        lead.subCategory,
        'brand_website',
      );
      await this.sleep(RATE_LIMIT_MS);
    }

    // Reverse
    for (const entry of portfolioBrands) {
      if (!entry.brandWebsiteUrl) continue;
      const distributorNames = await this.scrapeWhereToBuy(entry.brandWebsiteUrl);

      // For the reverse pass we only care about finding the distributor that already owns this entry
      for (const name of distributorNames) {
        const match = await this.fuzzyMatchDistributor(name);
        if (!match || match.id === entry.distributorId) continue; // skip self
        inserted += await this.upsertPortfolioEntry({
          distributorId:   match.id,
          brandName:       entry.brandName,
          brandWebsiteUrl: entry.brandWebsiteUrl,
          categoryHint:    null,
          subCategoryHint: entry.subCategoryHint,
          source:          'brand_website',
          confidence:      0.75,
        });
      }
      await this.sleep(RATE_LIMIT_MS);
    }

    return inserted;
  }

  /** Visit a brand URL, find and follow a "where to buy" link, extract company names. */
  private async scrapeWhereToBuy(brandUrl: string): Promise<string[]> {
    if (!this.browser) return [];
    const page = await this.browser.newPage();
    try {
      await page.goto(brandUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await this.sleep(1500);

      // Find internal link matching where-to-buy patterns
      const links = await page.evaluate(`
        Array.from(document.querySelectorAll('a[href]')).map(a => ({
          href: a.href,
          text: (a.textContent || '').toLowerCase()
        }))
      `) as Array<{ href: string; text: string }>;

      const target = links.find(l =>
        WHERE_TO_BUY_PATTERNS.some(p => l.href.toLowerCase().includes(p) || l.text.includes(p))
      );

      if (target) {
        await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 15_000 });
        await this.sleep(1000);
      }

      const html = await page.content();
      return this.extractCompanyNames(html);
    } catch {
      return [];
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  /** Insert portfolio entries for resolved distributor names, return count inserted. */
  private async resolveAndInsertPortfolio(
    names: string[],
    brandName: string,
    brandWebsiteUrl: string,
    categoryHint: string | null,
    subCategoryHint: string | null,
    source: string,
  ): Promise<number> {
    let count = 0;
    for (const name of names) {
      const dist = await this.fuzzyMatchDistributor(name);
      if (!dist) continue;
      count += await this.upsertPortfolioEntry({
        distributorId: dist.id,
        brandName,
        brandWebsiteUrl,
        categoryHint,
        subCategoryHint,
        source,
        confidence: 0.8,
      });
    }
    return count;
  }

  // ---------------------------------------------------------------------------
  // Stage 2B — Faire + Bulletin agentOutputs (no new scraping)
  // ---------------------------------------------------------------------------

  private async strategyB_FaireBulletin(): Promise<number> {
    let inserted = 0;
    try {
      const rows = await db
        .select({ agentType: agentOutputs.agentType, raw: agentOutputs.outputData })
        .from(agentOutputs)
        .where(inArray(agentOutputs.agentType, ['faire', 'bulletin']))
        .limit(500);

      for (const row of rows) {
        const raw = row.raw as Record<string, unknown> | null;
        if (!raw) continue;

        // Faire/Bulletin outputs may carry brand↔buyer relationships
        const brandName    = typeof raw['brandName']    === 'string' ? raw['brandName']    : null;
        const buyerName    = typeof raw['buyerName']    === 'string' ? raw['buyerName']    : null;
        const retailerName = typeof raw['retailerName'] === 'string' ? raw['retailerName'] : null;
        const category     = typeof raw['category']     === 'string' ? raw['category']     : null;

        const partnerName = buyerName ?? retailerName;
        if (!brandName || !partnerName) continue;

        const dist = await this.fuzzyMatchDistributor(partnerName);
        if (!dist) continue;

        inserted += await this.upsertPortfolioEntry({
          distributorId:   dist.id,
          brandName,
          brandWebsiteUrl: typeof raw['websiteUrl'] === 'string' ? raw['websiteUrl'] : null,
          categoryHint:    category,
          subCategoryHint: null,
          source:          row.agentType,
          confidence:      0.9,
        });
      }
    } catch (err) {
      logger.warn({ err }, '[CompetitorIntel] Strategy B failed');
    }
    return inserted;
  }

  // ---------------------------------------------------------------------------
  // Stage 2C — distributor website portfolio scraping
  // ---------------------------------------------------------------------------

  private async strategyC_DistributorWebsites(): Promise<number> {
    if (!this.browser) return 0;

    const targetDists = await db
      .select({ id: distributors.id, name: distributors.name, websiteUrl: distributors.websiteUrl, categories: distributors.categories })
      .from(distributors)
      .where(and(
        isNotNull(distributors.websiteUrl),
        gt(distributors.distributorScore, MIN_DIST_SCORE),
      ))
      .limit(MAX_DIST_SCRAPES);

    let inserted = 0;

    for (const dist of targetDists) {
      if (!dist.websiteUrl) continue;
      const brandNames = await this.scrapeDistributorPortfolio(dist.websiteUrl);
      for (const brandName of brandNames) {
        inserted += await this.upsertPortfolioEntry({
          distributorId:   dist.id,
          brandName,
          brandWebsiteUrl: null,
          categoryHint:    (dist.categories ?? [])[0] ?? null,
          subCategoryHint: null,
          source:          'distributor_website',
          confidence:      0.6,
        });
      }
      await this.sleep(RATE_LIMIT_MS + 1000);
    }

    return inserted;
  }

  private async scrapeDistributorPortfolio(distUrl: string): Promise<string[]> {
    if (!this.browser) return [];
    const page = await this.browser.newPage();
    try {
      await page.goto(distUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await this.sleep(1500);

      const links = await page.evaluate(`
        Array.from(document.querySelectorAll('a[href]')).map(a => ({
          href: a.href,
          text: (a.textContent || '').toLowerCase()
        }))
      `) as Array<{ href: string; text: string }>;

      const target = links.find(l =>
        PORTFOLIO_PATTERNS.some(p => l.href.toLowerCase().includes(p) || l.text.includes(p))
      );

      if (target) {
        await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 15_000 });
        await this.sleep(1000);
      }

      const html = await page.content();
      return this.extractBrandNames(html);
    } catch {
      return [];
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------------------
  // Stage 3 — proximity classification + score adjustment
  // ---------------------------------------------------------------------------

  private async applyProximityFlags(): Promise<number> {
    // Only process matches where the lead has a sub-category assigned
    const matches = await db
      .select({
        matchId:       distributorBrandMatches.id,
        distributorId: distributorBrandMatches.distributorId,
        leadId:        distributorBrandMatches.leadId,
        matchScore:    distributorBrandMatches.matchScore,
        leadSubCat:    leads.subCategory,
        leadCategory:  leads.bestCategory,
      })
      .from(distributorBrandMatches)
      .innerJoin(leads, eq(distributorBrandMatches.leadId, leads.id))
      .where(isNotNull(leads.subCategory));

    let updated = 0;

    for (const match of matches) {
      if (!match.leadSubCat || !match.leadId) continue;

      const portfolio = await db
        .select({ subCategoryHint: distributorBrandPortfolio.subCategoryHint, categoryHint: distributorBrandPortfolio.categoryHint })
        .from(distributorBrandPortfolio)
        .where(eq(distributorBrandPortfolio.distributorId, match.distributorId));

      if (portfolio.length === 0) continue;

      const leadTopCat = topLevelCategory(match.leadSubCat) ?? match.leadCategory;

      let exactCount    = 0;
      let adjacentCount = 0;

      for (const entry of portfolio) {
        if (!entry.subCategoryHint) continue;
        if (entry.subCategoryHint === match.leadSubCat) {
          exactCount++;
        } else if (topLevelCategory(entry.subCategoryHint) === leadTopCat) {
          adjacentCount++;
        }
      }

      const proximity: string | null =
        exactCount > 0    ? 'exact' :
        adjacentCount > 0 ? 'adjacent' :
        null;

      const baseScore = match.matchScore ?? 0;
      const newScore  =
        proximity === 'exact'    ? Math.min(baseScore * EXACT_SCORE_FACTOR,   1.0) :
        proximity === 'adjacent' ? Math.min(baseScore * ADJACENT_SCORE_BONUS, 1.0) :
        baseScore;

      await db.update(distributorBrandMatches)
        .set({
          competitorProximity: proximity,
          competitorCount:     exactCount + adjacentCount,
          matchScore:          newScore,
        })
        .where(eq(distributorBrandMatches.id, match.matchId));

      updated++;
    }

    return updated;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Fuzzy-match a raw company name string against the distributors table. */
  private async fuzzyMatchDistributor(name: string): Promise<{ id: string } | null> {
    const normalised = name.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    if (normalised.length < 3) return null;

    try {
      const rows = await db
        .select({ id: distributors.id, name: distributors.name })
        .from(distributors)
        .where(sql`LOWER(REGEXP_REPLACE(${distributors.name}, '[^a-zA-Z0-9 ]', '', 'g')) LIKE ${`%${normalised}%`}`)
        .limit(1);
      return rows[0] ? { id: rows[0].id } : null;
    } catch {
      return null;
    }
  }

  /** Upsert a single portfolio entry; returns 1 if inserted/updated, 0 if no-op. */
  private async upsertPortfolioEntry(entry: {
    distributorId:   string;
    brandName:       string;
    brandWebsiteUrl: string | null;
    categoryHint:    string | null;
    subCategoryHint: string | null;
    source:          string;
    confidence:      number;
  }): Promise<number> {
    try {
      await db.insert(distributorBrandPortfolio)
        .values({
          distributorId:   entry.distributorId,
          brandName:       entry.brandName,
          brandWebsiteUrl: entry.brandWebsiteUrl ?? undefined,
          categoryHint:    entry.categoryHint ?? undefined,
          subCategoryHint: entry.subCategoryHint ?? undefined,
          source:          entry.source,
          confidence:      entry.confidence,
        })
        .onConflictDoUpdate({
          target:  [distributorBrandPortfolio.distributorId, distributorBrandPortfolio.brandName],
          set:     {
            source:          entry.source,
            confidence:      entry.confidence,
            subCategoryHint: entry.subCategoryHint ?? undefined,
            detectedAt:      new Date(),
          },
        });
      return 1;
    } catch {
      return 0;
    }
  }

  /** Extract company / distributor names from an HTML page. */
  private extractCompanyNames(html: string): string[] {
    const $ = cheerio.load(html);
    const names = new Set<string>();

    // Logo grids with alt text
    $('img[alt]').each((_, el) => {
      const alt = $(el).attr('alt')?.trim();
      if (alt && alt.length > 2 && alt.length < 80 && !/logo|icon|banner/i.test(alt)) names.add(alt);
    });

    // List items and table cells that look like company names
    $('li, td').each((_, el) => {
      const text = $(el).text().trim();
      if (text.length > 2 && text.length < 80 && !/^\d/.test(text)) names.add(text);
    });

    return [...names].slice(0, 40);
  }

  /** Extract brand names from a distributor's portfolio page. */
  private extractBrandNames(html: string): string[] {
    const $ = cheerio.load(html);
    const names = new Set<string>();

    $('img[alt]').each((_, el) => {
      const alt = $(el).attr('alt')?.trim();
      if (alt && alt.length > 2 && alt.length < 60 && !/logo|icon|placeholder/i.test(alt)) names.add(alt);
    });

    $('h2, h3, h4, .brand-name, [class*="brand"], [class*="partner"]').each((_, el) => {
      const text = $(el).text().trim();
      if (text.length > 1 && text.length < 60) names.add(text);
    });

    return [...names].slice(0, 60);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
