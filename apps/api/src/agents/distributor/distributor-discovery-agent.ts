import { db } from '@/db/index.js';
import { distributors, agentOutputs, tradeShowExhibitors } from '@/db/schema.js';
import { logger } from '@/lib/logger.js';
import { inArray, gte, and, sql } from 'drizzle-orm';

type DistributorCandidate = {
  companyName: string;
  websiteUrl?: string;
  categories?: string[];
  rawMetadata?: Record<string, unknown>;
};

type DiscoveryResult = {
  created: number;
  updated: number;
  skipped: number;
};

const DISTRIBUTOR_KEYWORDS = ['distributor', 'importer', 'wholesaler', 'buyer', 'procurement', 'import'];

export class DistributorDiscoveryAgent {
  async run(): Promise<DiscoveryResult> {
    let created = 0;
    let updated = 0;
    let skipped = 0;

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // Source 1: agent_outputs from industry-directory and linkedin crawlers
    const scraperOutputs = await db
      .select({ agentType: agentOutputs.agentType, outputData: agentOutputs.outputData })
      .from(agentOutputs)
      .where(
        and(
          inArray(agentOutputs.agentType, ['industry-directory', 'linkedin']),
          gte(agentOutputs.createdAt, sevenDaysAgo),
        ),
      );

    for (const output of scraperOutputs) {
      const candidates = output.outputData as DistributorCandidate[];
      if (!Array.isArray(candidates)) continue;

      for (const candidate of candidates) {
        const meta = candidate.rawMetadata ?? {};
        if (!meta.isDistributor) continue;

        const result = await this.upsertDistributor(candidate, String(meta.countryCode ?? ''), String(meta.source ?? output.agentType));
        if (result === 'created') { created++; }
        else if (result === 'updated') { updated++; }
        else { skipped++; }
      }
    }

    // Source 2: trade show exhibitors with distributor keywords in boothInfo
    const exhibitors = await db
      .select({
        brandName: tradeShowExhibitors.brandName,
        brandWebsite: tradeShowExhibitors.brandWebsite,
        categories: tradeShowExhibitors.categories,
        boothInfo: tradeShowExhibitors.boothInfo,
      })
      .from(tradeShowExhibitors)
      .where(sql`lower(booth_info) ~ ${DISTRIBUTOR_KEYWORDS.join('|')}`);

    for (const exhibitor of exhibitors) {
      if (!exhibitor.boothInfo) continue;

      const candidate: DistributorCandidate = {
        companyName: exhibitor.brandName,
        websiteUrl: exhibitor.brandWebsite ?? undefined,
        categories: exhibitor.categories ?? [],
      };
      const result = await this.upsertDistributor(candidate, '', 'trade_show');
      if (result === 'created') { created++; }
      else if (result === 'updated') { updated++; }
      else { skipped++; }
    }

    logger.info({ created, updated, skipped }, 'DistributorDiscoveryAgent completed');
    return { created, updated, skipped };
  }

  private async upsertDistributor(
    candidate: DistributorCandidate,
    countryCode: string,
    source: string,
  ): Promise<'created' | 'updated' | 'skipped'> {
    const name = candidate.companyName?.trim();
    if (!name || name.length < 2) return 'skipped';

    // Infer countryCode from website TLD if not provided
    const resolvedCountry = countryCode || this.inferCountryFromUrl(candidate.websiteUrl);

    const existing = await db
      .select({ id: distributors.id })
      .from(distributors)
      .where(sql`lower(name) = lower(${name}) AND country_code = ${resolvedCountry}`)
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(distributors)
        .set({
          categories: candidate.categories ?? [],
          websiteUrl: candidate.websiteUrl,
          discoverySource: source,
          updatedAt: new Date(),
        })
        .where(sql`id = ${existing[0].id}`);
      return 'updated';
    }

    const inserted = await db
      .insert(distributors)
      .values({
        name,
        countryCode: resolvedCountry || 'EU',
        categories: candidate.categories ?? [],
        websiteUrl: candidate.websiteUrl,
        discoverySource: source,
        importsUsGoods: false,
      })
      .onConflictDoNothing()
      .returning({ id: distributors.id });

    return inserted.length > 0 ? 'created' : 'skipped';
  }

  private inferCountryFromUrl(url?: string): string {
    if (!url) return '';
    try {
      const tld = new URL(url).hostname.split('.').pop() ?? '';
      const TLD_MAP: Record<string, string> = { de: 'DE', fr: 'FR', nl: 'NL', be: 'BE', es: 'ES', it: 'IT', uk: 'GB', co: 'GB', ie: 'IE', at: 'AT', pl: 'PL', se: 'SE', dk: 'DK' };
      return TLD_MAP[tld] ?? '';
    } catch {
      return '';
    }
  }
}
