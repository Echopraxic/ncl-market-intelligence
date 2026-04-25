import { BaseCrawler, type CrawlResult } from './base-crawler.js';

export type LeadCandidate = {
  companyName: string;
  websiteUrl?: string;
  email?: string;
  linkedinUrl?: string;
  categories?: string[];
  annualRevenueEstimate?: number;
  employeeCount?: number;
  euPresence?: boolean;
  employeeGrowthSignal?: string;
  rawMetadata?: Record<string, unknown>;
};

export abstract class BaseLeadCrawler extends BaseCrawler {
  /** All lead crawlers implement this instead of run() directly.
   *  Returns raw candidates; LeadDiscoveryAgent handles deduplication + DB upsert. */
  abstract extractLeads(): Promise<LeadCandidate[]>;

  async run(): Promise<CrawlResult> {
    const errors: string[] = [];
    let candidates: LeadCandidate[] = [];

    try {
      candidates = await this.extractLeads();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(msg);
    }

    return {
      crawlerType: this.crawlerType,
      recordsFound: candidates.length,
      newRecordsFound: candidates.length,
      pagesScraped: 0,
      errors,
      structuredErrors: [],
    };
  }
}
