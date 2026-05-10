import { chromium, type Browser } from 'playwright';
import * as cheerio from 'cheerio';
import { logger } from '@/lib/logger.js';
import { db } from '@/db/index.js';
import { agentOutputs } from '@/db/schema.js';
import { BaseLeadCrawler, type LeadCandidate } from './base-lead-crawler.js';
import { CrawlErrorCode, classifyError, type StructuredCrawlError } from '@/lib/crawler-errors.js';
import type { CrawlResult } from './base-crawler.js';

const MAX_PAGES_PER_SECTION = 5;

interface DirectorySection {
  name: string;
  url: string;
  countryCode: string;
  category: string;
  source: string;  // 'europages' | 'kompass'
}

const SECTIONS: DirectorySection[] = [
  // EuroPages — food/beverage by country
  { name: 'europages-food-DE', url: 'https://www.europages.co.uk/companies/food-beverages-tobacco.html?country=DE', countryCode: 'DE', category: 'food_beverage', source: 'europages' },
  { name: 'europages-food-FR', url: 'https://www.europages.co.uk/companies/food-beverages-tobacco.html?country=FR', countryCode: 'FR', category: 'food_beverage', source: 'europages' },
  { name: 'europages-food-NL', url: 'https://www.europages.co.uk/companies/food-beverages-tobacco.html?country=NL', countryCode: 'NL', category: 'food_beverage', source: 'europages' },
  { name: 'europages-food-GB', url: 'https://www.europages.co.uk/companies/food-beverages-tobacco.html?country=GB', countryCode: 'GB', category: 'food_beverage', source: 'europages' },
  // EuroPages — cosmetics/health by country
  { name: 'europages-cosm-DE', url: 'https://www.europages.co.uk/companies/cosmetics-body-care.html?country=DE', countryCode: 'DE', category: 'cosmetics_personal_care', source: 'europages' },
  { name: 'europages-cosm-FR', url: 'https://www.europages.co.uk/companies/cosmetics-body-care.html?country=FR', countryCode: 'FR', category: 'cosmetics_personal_care', source: 'europages' },
  // EuroPages — supplements (pharmaceutical/health)
  { name: 'europages-supp-DE', url: 'https://www.europages.co.uk/companies/pharmaceutical-industry.html?country=DE', countryCode: 'DE', category: 'supplements', source: 'europages' },
  // Kompass — food/beverage Germany
  { name: 'kompass-food-DE', url: 'https://uk.kompass.com/b/food-and-beverages/?country=DE', countryCode: 'DE', category: 'food_beverage', source: 'kompass' },
  // Kompass — health/beauty Germany
  { name: 'kompass-health-DE', url: 'https://uk.kompass.com/b/health-and-beauty/?country=DE', countryCode: 'DE', category: 'cosmetics_personal_care', source: 'kompass' },
];

// Selector chains for each source
const SELECTORS = {
  europages: {
    cards: ['[class*="company-card"]', '[class*="result-item"]', 'article.company', 'li.company', '[data-cy*="company"]', '.listing-item'],
    name:  ['h2', 'h3', '.company-name', '[class*="company-name"]', 'a[class*="name"]'],
    website: ['a[href^="http"]:not([href*="europages"])'],
    category: ['.tag', '.category', '[class*="tag"]', 'span[class*="activity"]'],
  },
  kompass: {
    cards: ['.company-card', '.company-result', 'article', 'li[class*="company"]', '.result-item'],
    name:  ['h2', 'h3', '.company-name', 'a[class*="company"]'],
    website: ['a[href^="http"]:not([href*="kompass"])'],
    category: ['.tag', '.activity', '[class*="activity"]', '.badge'],
  },
};

export class IndustryDirectoryCrawler extends BaseLeadCrawler {
  readonly crawlerType = 'industry-directory';
  protected override readonly rateLimitMs = 3000;

  async extractLeads(): Promise<LeadCandidate[]> {
    return [];
  }

  override async run(): Promise<CrawlResult> {
    const errors: string[] = [];
    const structuredErrors: StructuredCrawlError[] = [];
    const candidates: LeadCandidate[] = [];
    const seenDomains = new Set<string>();
    let pagesScraped = 0;
    let browser: Browser | undefined;

    try {
      browser = await chromium.launch({ headless: true });

      for (const section of SECTIONS) {
        const log = logger.child({ crawler: this.crawlerType, section: section.name });
        const selectors = SELECTORS[section.source as keyof typeof SELECTORS];

        for (let pageNum = 1; pageNum <= MAX_PAGES_PER_SECTION; pageNum++) {
          const pageUrl = pageNum === 1 ? section.url : `${section.url}&page=${pageNum}`;

          try {
            await this.sleep(this.currentRateLimitMs);

            const context = await browser.newContext({
              userAgent: this.getNextUserAgent(),
              viewport: { width: 1280, height: 900 },
            });
            const page = await context.newPage();

            await page.route('**/*', (route) => {
              const type = route.request().resourceType();
              if (['image', 'media', 'font'].includes(type)) void route.abort();
              else void route.continue();
            });

            let foundOnPage = 0;

            try {
              const response = await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 });

              if (!response || response.status() >= 400) {
                log.info({ pageNum, status: response?.status() }, 'Non-200 response, stopping section');
                await page.close(); await context.close(); break;
              }

              const { html } = await this.captureRenderedDOM(page, { postLoadDelayMs: 1500 });
              const $ = cheerio.load(html);

              // Try each card selector, use first that produces results
              let cardSelector = '';
              for (const sel of selectors.cards) {
                if ($(sel).length >= 2) { cardSelector = sel; break; }
              }

              if (!cardSelector) {
                log.info({ pageNum }, 'No company cards found — stopping section');
                await page.close(); await context.close(); break;
              }

              $(cardSelector).each((_i, el) => {
                // Extract name
                let name = '';
                for (const sel of selectors.name) {
                  const t = $(el).find(sel).first().text().trim();
                  if (t && t.length > 1 && t.length < 200) { name = t; break; }
                }
                if (!name) name = $(el).find('a').first().text().trim();
                if (!name || name.length < 2) return;

                // Extract website
                let websiteUrl: string | undefined;
                for (const sel of selectors.website) {
                  const href = $(el).find(sel).first().attr('href');
                  if (href?.startsWith('http')) { websiteUrl = href; break; }
                }

                // Dedup by domain
                if (websiteUrl) {
                  try {
                    const domain = new URL(websiteUrl).hostname;
                    if (seenDomains.has(domain)) return;
                    seenDomains.add(domain);
                  } catch { /* invalid URL, skip dedup */ }
                }

                // Extract categories
                const categoryTags = selectors.category
                  .flatMap(sel => $(el).find(sel).map((_j, c) => $(c).text().trim()).get())
                  .filter(t => t && t.length > 1 && t.length < 60);

                candidates.push({
                  companyName: name,
                  websiteUrl,
                  categories: categoryTags.length > 0 ? categoryTags : [section.category],
                  rawMetadata: {
                    isDistributor: true,
                    countryCode: section.countryCode,
                    source: section.source,
                    category: section.category,
                    crawledUrl: pageUrl,
                    page: pageNum,
                  },
                });
                foundOnPage++;
              });

              pagesScraped++;
              this.adjustRateLimit('success');
              log.info({ pageNum, found: foundOnPage, total: candidates.length }, 'Directory page scraped');

              if (foundOnPage === 0) {
                await page.close(); await context.close(); break;
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              const code = classifyError(msg);
              structuredErrors.push({
                code,
                domain: new URL(section.url).hostname,
                message: msg,
                retryable: [CrawlErrorCode.TIMEOUT, CrawlErrorCode.NETWORK_ERROR].includes(code),
                timestamp: new Date().toISOString(),
              });
              errors.push(`${section.name}:page${pageNum}: ${msg}`);
              this.adjustRateLimit('bot_blocked');
              await page.close(); await context.close(); break;
            }

            await page.close(); await context.close();
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`${section.name}:page${pageNum}: ${msg}`);
            break;
          }
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
      logger.info({ count: candidates.length }, '[IndustryDirectoryCrawler] Candidates persisted');
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
