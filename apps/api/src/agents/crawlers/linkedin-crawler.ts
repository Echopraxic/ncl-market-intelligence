import { chromium, type Browser } from 'playwright';
import * as cheerio from 'cheerio';
import { db } from '@/db/index.js';
import { brands } from '@/db/schema.js';
import { logger } from '@/lib/logger.js';
import { isNotNull } from 'drizzle-orm';
import { BaseLeadCrawler, type LeadCandidate } from './base-lead-crawler.js';
import { CrawlErrorCode, classifyError, type StructuredCrawlError } from '@/lib/crawler-errors.js';
import type { CrawlResult } from './base-crawler.js';

const MAX_COMPANIES_PER_RUN = 20;
const EU_HIRING_KEYWORDS = ['germany', 'france', 'netherlands', 'spain', 'italy', 'eu', 'europe', 'amsterdam', 'berlin', 'paris', 'madrid', 'milan'];

export class LinkedInCrawler extends BaseLeadCrawler {
  readonly crawlerType = 'linkedin';

  protected override readonly rateLimitMs = 8000;

  async extractLeads(): Promise<LeadCandidate[]> {
    return [];
  }

  override async run(): Promise<CrawlResult> {
    const errors: string[] = [];
    const structuredErrors: StructuredCrawlError[] = [];
    const candidates: LeadCandidate[] = [];
    let pagesScraped = 0;
    let browser: Browser | undefined;

    // Only scrape known brands to reduce TOS risk and bot-block rate
    const knownBrands = await db
      .select({ id: brands.id, name: brands.name, websiteUrl: brands.websiteUrl })
      .from(brands)
      .where(isNotNull(brands.websiteUrl))
      .limit(MAX_COMPANIES_PER_RUN);

    if (knownBrands.length === 0) {
      return { crawlerType: this.crawlerType, recordsFound: 0, newRecordsFound: 0, pagesScraped: 0, errors: [], structuredErrors: [] };
    }

    try {
      browser = await chromium.launch({ headless: true });

      for (const brand of knownBrands) {
        try {
          await this.sleep(this.rateLimitMs);
          const slug = this.domainToSlug(brand.websiteUrl!);
          const url = `https://www.linkedin.com/company/${slug}`;
          const log = logger.child({ brand: brand.name, url });
          log.info('Scraping LinkedIn company page');

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
            const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });

            if (!response || response.status() === 404) {
              log.debug('LinkedIn page not found — skipping');
              continue;
            }

            if (response.status() === 403 || response.status() >= 400) {
              const structError: StructuredCrawlError = {
                code: CrawlErrorCode.AUTH_REQUIRED,
                domain: 'linkedin.com',
                message: `LinkedIn returned ${response.status()} for ${brand.name}`,
                retryable: false,
                timestamp: new Date().toISOString(),
              };
              structuredErrors.push(structError);
              this.adjustRateLimit('bot_blocked');
              continue;
            }

            const { html } = await this.captureRenderedDOM(page, { postLoadDelayMs: 1500 });
            const $ = cheerio.load(html);

            const employeeText = $('[data-test-id="about-us__size"], .company-about-us__size, .org-about-us-company-module__company-size-definition-text').first().text().trim();
            const employeeCount = this.parseEmployeeRange(employeeText);

            // Check for EU hiring signals in page text
            const pageText = $('body').text().toLowerCase();
            let employeeGrowthSignal: string | undefined;
            if (EU_HIRING_KEYWORDS.some(kw => pageText.includes(kw))) {
              employeeGrowthSignal = 'hiring_eu';
            }

            const linkedinUrl = url;

            candidates.push({
              companyName: brand.name,
              websiteUrl: brand.websiteUrl ?? undefined,
              linkedinUrl,
              employeeCount: employeeCount ?? undefined,
              employeeGrowthSignal,
              rawMetadata: { brandId: brand.id, source: 'linkedin', slug },
            });

            pagesScraped++;
            this.adjustRateLimit('success');
            log.info({ employeeCount, employeeGrowthSignal }, 'LinkedIn page scraped');
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const errorCode = classifyError(msg);
            structuredErrors.push({
              code: errorCode,
              domain: 'linkedin.com',
              message: `${brand.name}: ${msg}`,
              retryable: false,
              timestamp: new Date().toISOString(),
            });
            errors.push(`linkedin:${brand.name}: ${msg}`);
          } finally {
            await page.close();
            await context.close();
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`linkedin:${brand.name}: ${msg}`);
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

  private domainToSlug(websiteUrl: string): string {
    try {
      const hostname = new URL(websiteUrl).hostname.replace(/^www\./, '');
      return hostname.split('.')[0].toLowerCase().replace(/[^a-z0-9-]/g, '-');
    } catch {
      return websiteUrl.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 50);
    }
  }

  private parseEmployeeRange(text: string): number | null {
    const match = text.match(/(\d[\d,]*)\s*[-–]\s*(\d[\d,]*)/);
    if (match) {
      const low = parseInt(match[1].replace(/,/g, ''), 10);
      const high = parseInt(match[2].replace(/,/g, ''), 10);
      return Math.round((low + high) / 2);
    }
    const single = text.match(/(\d[\d,]+)/);
    if (single) return parseInt(single[1].replace(/,/g, ''), 10);
    return null;
  }
}
