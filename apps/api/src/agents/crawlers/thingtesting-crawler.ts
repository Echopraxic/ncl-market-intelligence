import { chromium, type Browser, type Page } from 'playwright';
import * as cheerio from 'cheerio';
import { logger } from '@/lib/logger.js';
import { db } from '@/db/index.js';
import { agentOutputs } from '@/db/schema.js';
import { BaseLeadCrawler, type LeadCandidate } from './base-lead-crawler.js';
import { CrawlErrorCode, classifyError, type StructuredCrawlError } from '@/lib/crawler-errors.js';
import type { CrawlResult } from './base-crawler.js';

const THINGTESTING_CATEGORY_URLS = [
  { url: 'https://thingtesting.com/brands?category=food-beverage',    category: 'food_beverage' },
  { url: 'https://thingtesting.com/brands?category=health-wellness',  category: 'supplements' },
  { url: 'https://thingtesting.com/brands?category=beauty',           category: 'cosmetics_personal_care' },
  { url: 'https://thingtesting.com/brands?category=home',             category: 'home_goods' },
  { url: 'https://thingtesting.com/brands',                           category: 'general' },
];

const MAX_PAGES = 8;
// Max detail-page visits per listing page to avoid spending hours crawling.
// Remaining brands are recorded without a website URL.
const MAX_DETAIL_VISITS_PER_PAGE = 5;

export class ThingTestingCrawler extends BaseLeadCrawler {
  readonly crawlerType = 'thingtesting';
  protected override readonly rateLimitMs = 2500;

  async extractLeads(): Promise<LeadCandidate[]> {
    return [];
  }

  override async run(): Promise<CrawlResult> {
    const errors: string[] = [];
    const structuredErrors: StructuredCrawlError[] = [];
    const candidates: LeadCandidate[] = [];
    const seenSlugs = new Set<string>();
    let pagesScraped = 0;
    let browser: Browser | undefined;

    try {
      browser = await chromium.launch({ headless: true });

      for (const { url: baseUrl, category } of THINGTESTING_CATEGORY_URLS) {
        const log = logger.child({ crawlerType: this.crawlerType, category });
        // currentUrl is null when there is no next page
        let currentUrl: string | null = baseUrl;
        let pageNum = 1;

        while (pageNum <= MAX_PAGES && currentUrl) {
          try {
            await this.sleep(this.currentRateLimitMs);

            const context = await browser.newContext({
              userAgent: this.getNextUserAgent(),
              viewport: { width: 1280, height: 900 },
              javaScriptEnabled: true,
            });
            const page = await context.newPage();

            // Block heavy resources but allow JS
            await page.route('**/*', (route) => {
              const type = route.request().resourceType();
              if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
                void route.abort();
              } else {
                void route.continue();
              }
            });

            let foundOnPage = 0;

            try {
              // domcontentloaded is faster than networkidle and less likely to timeout
              // on analytics-heavy pages; waitForSelector handles React hydration.
              await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });

              // Wait for brand grid to appear
              await page.waitForSelector('a[href^="/brands/"]', { timeout: 10_000 });

              // Scroll to trigger lazy loading
              await this.scrollToBottom(page);

              const { html } = await this.captureRenderedDOM(page, { postLoadDelayMs: 2000 });
              const $ = cheerio.load(html);

              // Find all brand links — ThingTesting uses /brands/[slug] pattern
              const brandLinks = $('a[href^="/brands/"]')
                .map((_i, el) => {
                  const href = $(el).attr('href') ?? '';
                  const slug = href.replace('/brands/', '').split('?')[0];
                  return { href, slug, $el: $(el) };
                })
                .get()
                .filter((item: { href: string; slug: string }) => item.slug && item.slug.length > 1);

              if (brandLinks.length === 0) {
                log.info({ page: pageNum }, 'No brand links found — stopping category');
                await page.close();
                await context.close();
                break;
              }

              let detailVisitsThisPage = 0;

              for (const { href, slug, $el } of brandLinks as Array<{ href: string; slug: string; $el: ReturnType<typeof $> }>) {
                if (seenSlugs.has(slug)) continue;
                seenSlugs.add(slug);

                // Use the slug (actual brand name from URL) as primary name.
                // Fall back to DOM extraction if slug is too short/invalid.
                const domName = $el.find('h2, h3, h4, p').first().text().trim()
                             || $el.text().trim().split('\n')[0].trim();
                const name = (slug.length > 2 ? slug : null) || domName;

                if (!name || name.length < 2) continue;

                // ThingTesting listing pages don't show external URLs directly.
                // Visit the brand detail page only for the first N brands per listing
                // page — visiting every brand page would make the crawler take hours
                // and guarantees bot detection.
                let website: string | null = null;
                if (detailVisitsThisPage < MAX_DETAIL_VISITS_PER_PAGE) {
                  website = await this.extractWebsiteFromBrandPage(page, href, log);
                  detailVisitsThisPage++;
                }

                // Extract category tags visible on the card
                const categoryText = $el.find('span, div')
                  .filter((_i, c) => $(c).text().length < 30)
                  .map((_i, c) => $(c).text().trim())
                  .get()
                  .filter((t: string) => t && !t.includes(name));

                candidates.push({
                  companyName: name,
                  websiteUrl: website ?? undefined,
                  categories: categoryText.length > 0 ? categoryText : [category],
                  rawMetadata: {
                    source: 'thingtesting',
                    crawledUrl: currentUrl,
                    page: pageNum,
                    thingtestingSlug: slug,
                    thingtestingUrl: `https://thingtesting.com${href}`,
                  },
                });
                foundOnPage++;
              }

              pagesScraped++;
              this.adjustRateLimit('success');
              log.info({ page: pageNum, found: foundOnPage, totalSoFar: candidates.length }, 'ThingTesting page scraped');

              // Check for next page
              currentUrl = this.findNextPageUrl($, currentUrl);
              pageNum++;

              if (foundOnPage === 0 || !currentUrl) {
                await page.close();
                await context.close();
                break;
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              const code = classifyError(msg);
              structuredErrors.push({
                code,
                domain: 'thingtesting.com',
                category,
                message: msg,
                retryable: [CrawlErrorCode.TIMEOUT, CrawlErrorCode.NETWORK_ERROR].includes(code),
                timestamp: new Date().toISOString(),
              });
              errors.push(`thingtesting:${category}:page${pageNum}: ${msg}`);
              this.adjustRateLimit('bot_blocked');
              await page.close();
              await context.close();
              break;
            }

            await page.close();
            await context.close();
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`thingtesting:${category}:page${pageNum}: ${msg}`);
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
      logger.info({ count: candidates.length }, '[ThingTestingCrawler] Candidates persisted to agent_outputs');
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

  /** Scroll to bottom to trigger infinite scroll / lazy loading */
  private async scrollToBottom(page: Page): Promise<void> {
    // Use Playwright's mouse wheel API — avoids needing DOM types in Node tsconfig
    for (let i = 0; i < 15; i++) {
      await page.mouse.wheel(0, 500);
      await this.sleep(150);
    }
  }

  /**
   * Visit a brand detail page to extract the external website URL.
   * Only called for the first MAX_DETAIL_VISITS_PER_PAGE brands per listing page.
   */
  private async extractWebsiteFromBrandPage(
    page: Page,
    brandPath: string,
    log: { debug: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void },
  ): Promise<string | null> {
    try {
      const brandPage = await page.context().newPage();
      await brandPage.goto(`https://thingtesting.com${brandPath}`, {
        waitUntil: 'domcontentloaded',
        timeout: 15_000,
      });
      await brandPage.waitForTimeout(1500);

      const html = await brandPage.content();
      const $ = cheerio.load(html);

      // Method 1: "Visit website" / "Shop" button
      const externalLink = $('a[href^="http"]:not([href*="thingtesting.com"])')
        .filter((_: number, el: cheerio.Element) => {
          const text = $(el).text().toLowerCase();
          return text.includes('visit') || text.includes('website') || text.includes('shop');
        })
        .first()
        .attr('href');

      // Method 2: JSON-LD structured data
      const jsonLd = $('script[type="application/ld+json"]').first().html();
      let jsonLdUrl: string | null = null;
      if (jsonLd) {
        try {
          const data = JSON.parse(jsonLd) as { url?: string; sameAs?: string[] };
          jsonLdUrl = data.url ?? data.sameAs?.find((u) => !u.includes('thingtesting.com')) ?? null;
        } catch { /* ignore */ }
      }

      // Method 3: Any external link with rel="noopener"
      const anyExternal = $('a[rel*="noopener"][href^="http"]:not([href*="thingtesting.com"])')
        .first()
        .attr('href');

      await brandPage.close();

      const result = externalLink ?? jsonLdUrl ?? anyExternal ?? null;
      if (result) {
        log.debug({ brand: brandPath, website: result }, 'Found external website');
      }
      return result ?? null;
    } catch (err) {
      log.warn({ brand: brandPath, error: (err as Error).message }, 'Failed to extract website from brand page');
      return null;
    }
  }

  /** Detect next-page URL from pagination links. */
  private findNextPageUrl($: ReturnType<typeof cheerio.load>, currentUrl: string): string | null {
    const nextLink = $('a[href*="page="], a[aria-label="Next"], a[aria-label="next"]')
      .first()
      .attr('href');

    if (nextLink) {
      return nextLink.startsWith('http') ? nextLink : `https://thingtesting.com${nextLink}`;
    }

    // Increment ?page= parameter if present in current URL
    try {
      const u = new URL(currentUrl);
      const p = u.searchParams.get('page');
      if (p !== null) {
        u.searchParams.set('page', String(parseInt(p, 10) + 1));
        return u.toString();
      }
    } catch { /* ignore */ }

    return null;
  }
}
