import { db } from '@/db/index.js';
import { leads, brands, tradeShowExhibitors, opportunityScores, agentOutputs } from '@/db/schema.js';
import { logger } from '@/lib/logger.js';
import { eq, inArray, isNull, gte, and, isNotNull } from 'drizzle-orm';
import { sql } from 'drizzle-orm';

type LeadCandidate = {
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

type DiscoveryResult = {
  leadsCreated: number;
  leadsSkipped: number;
  leadTypes: Record<string, number>;
};

export class LeadDiscoveryAgent {
  async run(): Promise<DiscoveryResult> {
    let leadsCreated = 0;
    let leadsSkipped = 0;
    const leadTypes: Record<string, number> = {};

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // Source 1: Lead candidates from scraper agent_outputs (last 7 days)
    const scraperOutputs = await db
      .select({ agentType: agentOutputs.agentType, outputData: agentOutputs.outputData })
      .from(agentOutputs)
      .where(
        and(
          inArray(agentOutputs.agentType, ['product-hunt', 'linkedin', 'cpg-directory']),
          gte(agentOutputs.createdAt, sevenDaysAgo),
        ),
      );

    for (const output of scraperOutputs) {
      const candidates = output.outputData as LeadCandidate[];
      if (!Array.isArray(candidates)) continue;

      for (const candidate of candidates) {
        const result = await this.upsertLead(candidate, 'brand_discovery', output.agentType);
        if (result.created) {
          leadsCreated++;
          leadTypes['brand_discovery'] = (leadTypes['brand_discovery'] ?? 0) + 1;
        } else {
          leadsSkipped++;
        }
      }
    }

    // Source 2: Brands already scored above threshold — not yet in leads
    const scoredBrands = await db
      .select({
        id: brands.id,
        name: brands.name,
        websiteUrl: brands.websiteUrl,
        categories: brands.categories,
        annualRevenueEstimate: brands.annualRevenueEstimate,
        employeeCount: brands.employeeCount,
        euPresence: brands.euPresence,
        compositeScore: opportunityScores.compositeScore,
      })
      .from(brands)
      .innerJoin(opportunityScores, and(
        eq(opportunityScores.brandId, brands.id),
        gte(opportunityScores.compositeScore, 60),
      ))
      .where(isNotNull(brands.websiteUrl));

    for (const brand of scoredBrands) {
      // Skip if already in leads
      const existing = await db
        .select({ id: leads.id })
        .from(leads)
        .where(eq(leads.brandId, brand.id))
        .limit(1);

      if (existing.length > 0) {
        leadsSkipped++;
        continue;
      }

      await db.insert(leads).values({
        companyName: brand.name,
        websiteUrl: brand.websiteUrl ?? undefined,
        leadType: 'brand_scored',
        discoverySource: 'brand_scorer',
        brandId: brand.id,
        categories: brand.categories ?? [],
        annualRevenueEstimate: brand.annualRevenueEstimate ?? undefined,
        employeeCount: brand.employeeCount ?? undefined,
        euPresence: brand.euPresence ?? false,
        opportunityScore: brand.compositeScore,
      }).onConflictDoNothing();

      leadsCreated++;
      leadTypes['brand_scored'] = (leadTypes['brand_scored'] ?? 0) + 1;
    }

    // Source 3: Trade show exhibitors not yet in leads
    const exhibitors = await db
      .select({
        brandName: tradeShowExhibitors.brandName,
        brandWebsite: tradeShowExhibitors.brandWebsite,
        categories: tradeShowExhibitors.categories,
      })
      .from(tradeShowExhibitors);

    for (const exhibitor of exhibitors) {
      if (!exhibitor.brandWebsite) continue;

      const normalizedDomain = this.normalizeDomain(exhibitor.brandWebsite);
      const existing = exhibitor.brandWebsite
        ? await db
            .select({ id: leads.id })
            .from(leads)
            .where(sql`leads.website_url IS NOT NULL AND lower(leads.website_url) = lower(${normalizedDomain})`)
            .limit(1)
        : [];

      if (existing.length > 0) {
        leadsSkipped++;
        continue;
      }

      const matchedBrand = exhibitor.brandWebsite
        ? await db
            .select({ id: brands.id })
            .from(brands)
            .where(sql`lower(brands.website_url) = lower(${normalizedDomain})`)
            .limit(1)
        : [];

      await db.insert(leads).values({
        companyName: exhibitor.brandName,
        websiteUrl: exhibitor.brandWebsite,
        leadType: 'exhibitor',
        discoverySource: 'trade_show',
        brandId: matchedBrand[0]?.id ?? null,
        categories: exhibitor.categories ?? [],
      }).onConflictDoNothing();

      leadsCreated++;
      leadTypes['exhibitor'] = (leadTypes['exhibitor'] ?? 0) + 1;
    }

    logger.info({ leadsCreated, leadsSkipped, leadTypes }, 'LeadDiscoveryAgent completed');
    return { leadsCreated, leadsSkipped, leadTypes };
  }

  private normalizeDomain(url: string): string {
    try {
      const u = url.startsWith('http') ? url : `https://${url}`;
      return new URL(u).origin;
    } catch {
      return url;
    }
  }

  private async upsertLead(
    candidate: LeadCandidate,
    leadType: string,
    discoverySource: string,
  ): Promise<{ created: boolean }> {
    if (!candidate.websiteUrl && !candidate.email) {
      return { created: false };
    }

    const normalizedUrl = candidate.websiteUrl ? this.normalizeDomain(candidate.websiteUrl) : undefined;

    // Check if lead already exists by website URL
    if (normalizedUrl) {
      const existing = await db
        .select({ id: leads.id })
        .from(leads)
        .where(sql`lower(leads.website_url) = lower(${normalizedUrl})`)
        .limit(1);

      if (existing.length > 0) return { created: false };
    }

    // Find matching brand in our DB
    const matchedBrand = normalizedUrl
      ? await db
          .select({ id: brands.id, categories: brands.categories, annualRevenueEstimate: brands.annualRevenueEstimate, employeeCount: brands.employeeCount, euPresence: brands.euPresence })
          .from(brands)
          .where(sql`lower(brands.website_url) = lower(${normalizedUrl})`)
          .limit(1)
      : [];

    const brand = matchedBrand[0];

    await db.insert(leads).values({
      companyName: candidate.companyName,
      websiteUrl: normalizedUrl,
      email: candidate.email,
      linkedinUrl: candidate.linkedinUrl,
      leadType,
      discoverySource,
      brandId: brand?.id ?? null,
      categories: brand?.categories ?? candidate.categories ?? [],
      annualRevenueEstimate: brand?.annualRevenueEstimate ?? candidate.annualRevenueEstimate,
      employeeCount: brand?.employeeCount ?? candidate.employeeCount,
      euPresence: brand?.euPresence ?? candidate.euPresence ?? false,
      employeeGrowthSignal: candidate.employeeGrowthSignal,
    }).onConflictDoNothing();

    return { created: true };
  }
}
