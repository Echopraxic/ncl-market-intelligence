// src/agents/signals/trade-show-playbook-agent.ts
//
// TradeShowPlaybookAgent — Phase 3
//
// Produces rich, structured trade show playbooks for upcoming shows.
// Extends InsightGenerationAgent's basic trade_show_playbook insights with:
//
//   Exhibitor×Brand matching:
//     Cross-references each show's exhibitor list against our brands DB using
//     case-insensitive name matching. Matched brands include composite scores,
//     revenue tier, EU presence, Shopify signal, and a rule-based pitch angle.
//
//   Per-exhibitor prospect cards:
//     Every exhibitor gets a card: matched brands carry full scoring data;
//     unmatched exhibitors are listed as unscored leads for pipeline enrichment.
//
//   Distributor coverage map:
//     For each (category, countryCode) corridor intersecting the show, queries
//     the distributors table to surface coverage gaps NCL can fill as broker.
//
//   Structured output (trade_show_playbooks table):
//     All structured data is persisted alongside the DeepSeek 500–700 word
//     narrative. One row per show, upserted on each run.
//
// Trigger: POST /api/agents/trade-show-playbook/run
// Scope:   Upcoming shows only (startDate >= now)
// Chain:   Standalone — not part of TrendScheduler downstream chain

import { randomUUID } from 'crypto';
import { db } from '../../db/index.js';
import {
  tradeShows,
  tradeShowExhibitors,
  tradeShowPlaybooks,
  brands,
  opportunityScores,
  distributors,
  agentOutputs,
} from '../../db/schema.js';
import { and, desc, eq, isNull, isNotNull, gte, inArray, sql } from 'drizzle-orm';
import { logger } from '../../lib/logger.js';
import scoringWeights from '../../config/scoring-weights.json' with { type: 'json' };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEEPSEEK_API_URL    = 'https://api.deepseek.com/v1/chat/completions';
const DEEPSEEK_MODEL      = 'deepseek-chat';
const MAX_PIPELINE_BRANDS = 10;
const MAX_CORRIDORS_SHOWN = 6;

const COUNTRY_NAMES: Record<string, string> = {
  DE: 'Germany', FR: 'France', NL: 'Netherlands',
  GB: 'United Kingdom', ES: 'Spain', IT: 'Italy',
};
const CATEGORY_LABELS: Record<string, string> = {
  food_beverage:           'Food & Beverage',
  supplements:             'Health & Wellness Supplements',
  cosmetics_personal_care: 'Beauty & Personal Care',
  home_goods:              'Home Goods',
  toys_games:              'Toys & Games',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function revenueTierLabel(annualRevenue: number | null): string {
  if (annualRevenue === null)       return 'Unknown';
  if (annualRevenue < 1_000_000)   return 'Micro (<$1M)';
  if (annualRevenue < 10_000_000)  return 'Small ($1M–$10M)';
  if (annualRevenue < 100_000_000) return 'Mid ($10M–$100M)';
  return 'Large (>$100M)';
}

function buildPitchAngle(p: {
  compositeScore: number | null;
  euPresence: boolean | null;
  hasShopify: boolean;
}): string {
  const parts: string[] = [];

  if (p.compositeScore === null) {
    parts.push('Unscored exhibitor — gather brand profile and add to pipeline');
  } else if (p.compositeScore >= 80) {
    parts.push('Priority intercept — above outreach threshold; open conversation at show');
  } else if (p.compositeScore >= 70) {
    parts.push('High-value prospect — strong EU expansion indicators; NI routing pitch recommended');
  } else if (p.compositeScore >= 60) {
    parts.push('Qualified lead — category fit confirmed; probe EU ambitions and logistics pain points');
  } else {
    parts.push('Watch list — gather context and build relationship for future engagement');
  }

  if (!p.euPresence) parts.push('US-only distribution: NI dual-market routing eliminates EU market complexity');
  if (p.hasShopify)  parts.push('DTC/Shopify brand — EU marketplace expansion ready via NI fulfilment');
  return parts.join('. ');
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TradeShowPlaybookResult {
  showsProcessed:         number;
  playbooksWritten:       number;
  /** Fraction of exhibitors (across all shows) matched to our brands DB (0–1). */
  exhibitorMatchRate:     number;
  /** Total matched-exhibitor prospect cards generated across all shows. */
  prospectCardsGenerated: number;
}

interface ShowRow {
  id:          string;
  name:        string | null;
  location:    string | null;
  countryCode: string | null;
  startDate:   Date | null;
  endDate:     Date | null;
  categories:  string[] | null;
}

interface ScoreRecord {
  compositeScore: number;
  brandFitScore:  number;
  niScore:        number;
  category:       string;
  countryCode:    string;
}

interface BrandMatchData {
  id:                    string;
  annualRevenueEstimate: number | null;
  euPresence:            boolean | null;
  shopifyStoreUrl:       string | null;
  bestScore:             ScoreRecord | null;
}

interface CorridorScore {
  category:       string;
  countryCode:    string;
  compositeScore: number;
}

interface ExhibitorMatch {
  brandName:      string;
  brandId:        string | null;
  compositeScore: number | null;
  brandFitScore:  number | null;
  niScore:        number | null;
  annualRevenue:  number | null;
  euPresence:     boolean | null;
  hasShopify:     boolean;
  pitchAngle:     string;
}

interface DistributorCoverageItem {
  category:         string;
  countryCode:      string;
  distributorCount: number;
  distributorNames: string[];
  /** True when 0–1 distributors cover this corridor — flags a broker gap for NCL. */
  coverageGap:      boolean;
}

interface PipelineBrand {
  brandName:      string;
  brandId:        string;
  compositeScore: number;
  category:       string;
  countryCode:    string;
}

// ---------------------------------------------------------------------------
// TradeShowPlaybookAgent
// ---------------------------------------------------------------------------

export class TradeShowPlaybookAgent {

  // ── Category matching (mirrors InsightGenerationAgent) ────────────────────

  private matchShowCategories(showCategories: string[]): string[] {
    const matched  = new Set<string>();
    const aliases  = scoringWeights.categoryAliases as Record<string, string[]>;
    const keywords = scoringWeights.tradeShowCategoryKeywords as Record<string, string[]>;

    for (const showCat of showCategories) {
      const lower = showCat.toLowerCase().trim();
      for (const nclKey of Object.keys(aliases)) {
        const hit =
          (aliases[nclKey] ?? []).some(a => lower === a || lower.includes(a) || a.includes(lower)) ||
          (keywords[nclKey] ?? []).some(kw => lower.includes(kw));
        if (hit) matched.add(nclKey);
      }
    }
    return [...matched];
  }

  // ── Data fetchers ─────────────────────────────────────────────────────────

  private async fetchUpcomingShows(): Promise<ShowRow[]> {
    const now = new Date();
    return db
      .select({
        id:          tradeShows.id,
        name:        tradeShows.name,
        location:    tradeShows.location,
        countryCode: tradeShows.countryCode,
        startDate:   tradeShows.startDate,
        endDate:     tradeShows.endDate,
        categories:  tradeShows.categories,
      })
      .from(tradeShows)
      .where(and(isNotNull(tradeShows.startDate), gte(tradeShows.startDate!, now)));
  }

  private async fetchExhibitors(showId: string): Promise<Array<{ brandName: string; brandWebsite: string | null }>> {
    return db
      .select({ brandName: tradeShowExhibitors.brandName, brandWebsite: tradeShowExhibitors.brandWebsite })
      .from(tradeShowExhibitors)
      .where(eq(tradeShowExhibitors.tradeShowId, showId));
  }

  /**
   * Case-insensitive exhibitor→brand lookup.
   * Fetches all brands once (bounded internal table), filters in JS.
   * Then fetches the best opportunity score per matched brand in the given categories.
   */
  private async matchExhibitorsToBrands(
    exhibitorNames: string[],
    matchedCategories: string[],
  ): Promise<Map<string, BrandMatchData>> {
    if (exhibitorNames.length === 0 || matchedCategories.length === 0) return new Map();

    const allBrands = await db
      .select({
        id:                    brands.id,
        name:                  brands.name,
        annualRevenueEstimate: brands.annualRevenueEstimate,
        euPresence:            brands.euPresence,
        shopifyStoreUrl:       brands.shopifyStoreUrl,
      })
      .from(brands);

    const lowerNamesSet = new Set(exhibitorNames.map(n => n.toLowerCase()));
    const matched       = allBrands.filter(b => lowerNamesSet.has(b.name.toLowerCase()));
    if (matched.length === 0) return new Map();

    const brandIds = matched.map(b => b.id);

    const scoreRows = await db
      .select({
        brandId:              opportunityScores.brandId,
        category:             opportunityScores.category,
        countryCode:          opportunityScores.countryCode,
        compositeScore:       opportunityScores.compositeScore,
        brandFitScore:        opportunityScores.brandFitScore,
        niSuitabilityPreScore: opportunityScores.niSuitabilityPreScore,
      })
      .from(opportunityScores)
      .where(
        and(
          isNotNull(opportunityScores.brandId),
          inArray(opportunityScores.brandId, brandIds),
          inArray(opportunityScores.category, matchedCategories),
        ),
      )
      .orderBy(desc(opportunityScores.compositeScore));

    // Best score per brand (first row = highest compositeScore due to ORDER BY)
    const bestByBrand = new Map<string, ScoreRecord>();
    for (const row of scoreRows) {
      if (!row.brandId || bestByBrand.has(row.brandId)) continue;
      bestByBrand.set(row.brandId, {
        compositeScore: row.compositeScore,
        brandFitScore:  row.brandFitScore,
        niScore:        row.niSuitabilityPreScore,
        category:       row.category,
        countryCode:    row.countryCode,
      });
    }

    const result = new Map<string, BrandMatchData>();
    for (const brand of matched) {
      const originalName = exhibitorNames.find(n => n.toLowerCase() === brand.name.toLowerCase()) ?? brand.name;
      result.set(originalName, {
        id:                    brand.id,
        annualRevenueEstimate: brand.annualRevenueEstimate,
        euPresence:            brand.euPresence,
        shopifyStoreUrl:       brand.shopifyStoreUrl,
        bestScore:             bestByBrand.get(brand.id) ?? null,
      });
    }
    return result;
  }

  /**
   * For each (category, countryCode) corridor, count active distributors and
   * identify coverage gaps (≤1 distributor = gap NCL can fill).
   * Uses PostgreSQL @> array containment to match distributor categories.
   */
  private async fetchDistributorCoverage(
    corridors: Array<{ category: string; countryCode: string }>,
  ): Promise<DistributorCoverageItem[]> {
    if (corridors.length === 0) return [];

    const items: DistributorCoverageItem[] = [];
    for (const corridor of corridors) {
      const rows = await db
        .select({ name: distributors.name })
        .from(distributors)
        .where(
          and(
            eq(distributors.countryCode, corridor.countryCode),
            sql`${distributors.categories} @> ARRAY[${corridor.category}]::text[]`,
          ),
        )
        .limit(10);

      items.push({
        category:         corridor.category,
        countryCode:      corridor.countryCode,
        distributorCount: rows.length,
        distributorNames: rows.map(r => r.name),
        coverageGap:      rows.length <= 1,
      });
    }
    return items;
  }

  private async fetchCorridorScores(categories: string[]): Promise<CorridorScore[]> {
    if (categories.length === 0) return [];
    return db
      .select({
        category:       opportunityScores.category,
        countryCode:    opportunityScores.countryCode,
        compositeScore: opportunityScores.compositeScore,
      })
      .from(opportunityScores)
      .where(and(isNull(opportunityScores.brandId), inArray(opportunityScores.category, categories)))
      .orderBy(desc(opportunityScores.compositeScore))
      .limit(MAX_CORRIDORS_SHOWN);
  }

  private async fetchTopPipelineBrands(categories: string[]): Promise<PipelineBrand[]> {
    if (categories.length === 0) return [];
    const rows = await db
      .select({
        brandName:      brands.name,
        brandId:        brands.id,
        compositeScore: opportunityScores.compositeScore,
        category:       opportunityScores.category,
        countryCode:    opportunityScores.countryCode,
      })
      .from(opportunityScores)
      .innerJoin(brands, eq(opportunityScores.brandId, brands.id))
      .where(and(isNotNull(opportunityScores.brandId), inArray(opportunityScores.category, categories)))
      .orderBy(desc(opportunityScores.compositeScore))
      .limit(MAX_PIPELINE_BRANDS);

    return rows.map(r => ({
      brandName:      r.brandName,
      brandId:        r.brandId,
      compositeScore: r.compositeScore,
      category:       r.category,
      countryCode:    r.countryCode,
    }));
  }

  // ── Context builder ───────────────────────────────────────────────────────

  private buildContext(p: {
    show:                ShowRow;
    matchedCategories:   string[];
    corridors:           CorridorScore[];
    exhibitorMatches:    ExhibitorMatch[];
    unmatchedExhibitors: string[];
    distributorCoverage: DistributorCoverageItem[];
    topPipelineBrands:   PipelineBrand[];
    totalExhibitors:     number;
  }): string {
    const { show, matchedCategories, corridors, exhibitorMatches, unmatchedExhibitors, distributorCoverage, topPipelineBrands, totalExhibitors } = p;
    const matchedCount = exhibitorMatches.filter(e => e.brandId !== null).length;

    const lines: string[] = [
      `TRADE SHOW: ${show.name ?? 'Unknown'}`,
      `Location: ${show.location ?? 'TBC'} | Country: ${show.countryCode ? (COUNTRY_NAMES[show.countryCode] ?? show.countryCode) : 'TBC'}`,
      `Dates: ${show.startDate?.toLocaleDateString('en-GB') ?? 'TBC'} – ${show.endDate?.toLocaleDateString('en-GB') ?? 'TBC'}`,
      `NCL-Relevant Categories: ${matchedCategories.map(c => CATEGORY_LABELS[c] ?? c).join(', ') || 'None matched'}`,
      '',
    ];

    if (corridors.length > 0) {
      lines.push(`ACTIVE OPPORTUNITY CORRIDORS (${corridors.length} matched):`);
      corridors.forEach(c =>
        lines.push(`  • ${CATEGORY_LABELS[c.category] ?? c.category} × ${COUNTRY_NAMES[c.countryCode] ?? c.countryCode}: ${c.compositeScore.toFixed(1)}/100`)
      );
      lines.push('');
    }

    lines.push(`EXHIBITOR INTELLIGENCE (${matchedCount}/${totalExhibitors} exhibitors in NCL pipeline):`);

    const matchedExhibitors = exhibitorMatches.filter(e => e.brandId !== null);
    if (matchedExhibitors.length > 0) {
      lines.push('  MATCHED BRANDS:');
      matchedExhibitors.forEach((e, i) => {
        lines.push(`  ${i + 1}. ${e.brandName} — Composite: ${e.compositeScore?.toFixed(1) ?? 'N/A'}/100 | Brand Fit: ${e.brandFitScore?.toFixed(1) ?? 'N/A'} | NI: ${e.niScore?.toFixed(1) ?? 'N/A'}`);
        lines.push(`     Revenue: ${revenueTierLabel(e.annualRevenue)} | EU Presence: ${e.euPresence ? 'Yes' : 'No'} | Shopify: ${e.hasShopify ? 'Yes' : 'No'}`);
        lines.push(`     Pitch: ${e.pitchAngle}`);
      });
    }

    if (unmatchedExhibitors.length > 0) {
      const shown = unmatchedExhibitors.slice(0, 15);
      const extra = unmatchedExhibitors.length - shown.length;
      lines.push(`  UNSCORED EXHIBITORS (${unmatchedExhibitors.length}): ${shown.join(', ')}${extra > 0 ? ` + ${extra} more` : ''}`);
    }
    lines.push('');

    if (distributorCoverage.length > 0) {
      lines.push('DISTRIBUTOR COVERAGE MAP:');
      distributorCoverage.forEach(d => {
        const label = d.coverageGap ? 'COVERAGE GAP' : 'COVERED';
        lines.push(`  • ${CATEGORY_LABELS[d.category] ?? d.category} × ${COUNTRY_NAMES[d.countryCode] ?? d.countryCode}: ${d.distributorCount} distributor${d.distributorCount !== 1 ? 's' : ''} [${label}]`);
        if (d.distributorNames.length > 0)
          lines.push(`    Active: ${d.distributorNames.slice(0, 5).join(', ')}`);
      });
      lines.push('');
    }

    if (topPipelineBrands.length > 0) {
      lines.push('TOP PIPELINE BRANDS (not exhibiting, matching categories):');
      topPipelineBrands.forEach((b, i) =>
        lines.push(`  ${i + 1}. ${b.brandName} — ${b.compositeScore.toFixed(1)}/100 (${CATEGORY_LABELS[b.category] ?? b.category} × ${COUNTRY_NAMES[b.countryCode] ?? b.countryCode})`)
      );
    }

    return lines.join('\n');
  }

  // ── DeepSeek narrative call ───────────────────────────────────────────────

  private async callDeepSeek(context: string, instruction: string): Promise<string | null> {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return null;

    const system =
      'You are an EU market intelligence analyst for North Channel Logistics (NCL), ' +
      'a freight operator using Northern Ireland as a dual-access corridor to both the EU ' +
      'single market and the UK under the Windsor Framework. Write trade show playbooks for ' +
      'the NCL commercial team — specific, actionable, commercially direct. ' +
      'Plain prose only — no markdown, no headers, no bullet points.';

    try {
      const res = await fetch(DEEPSEEK_API_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body:    JSON.stringify({
          model:       DEEPSEEK_MODEL,
          messages:    [
            { role: 'system', content: system },
            { role: 'user',   content: `${context}\n\n${instruction}` },
          ],
          temperature: 0.4,
          max_tokens:  1200,
        }),
      });

      if (!res.ok) {
        logger.warn({ agent: 'TradeShowPlaybookAgent', status: res.status }, 'DeepSeek returned non-200 — using template');
        return null;
      }

      const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
      return data.choices[0]?.message?.content?.trim() ?? null;
    } catch (err) {
      logger.warn({ agent: 'TradeShowPlaybookAgent', err }, 'DeepSeek call failed — using template');
      return null;
    }
  }

  // ── Template fallback ─────────────────────────────────────────────────────

  private tplPlaybook(p: {
    show:                ShowRow;
    matchedCategories:   string[];
    corridors:           CorridorScore[];
    exhibitorMatches:    ExhibitorMatch[];
    distributorCoverage: DistributorCoverageItem[];
  }): string {
    const catList      = p.matchedCategories.map(c => CATEGORY_LABELS[c] ?? c).join(', ') || 'general consumer goods';
    const gapCorridors = p.distributorCoverage.filter(d => d.coverageGap);
    const topMatched   = p.exhibitorMatches.filter(e => e.brandId !== null).slice(0, 3);
    const showName     = p.show.name ?? 'This trade show';
    const location     = p.show.location ? ` in ${p.show.location}` : '';

    let body = `${showName}${location} is a high-priority intercept opportunity for NCL's EU brand acquisition pipeline, covering ${catList} — categories where active demand-supply gaps have been identified across key EU markets. `;

    if (p.corridors.length > 0) {
      const top = p.corridors[0];
      body += `The strongest opportunity corridor intersecting this show is ${CATEGORY_LABELS[top.category] ?? top.category} in ${COUNTRY_NAMES[top.countryCode] ?? top.countryCode} (composite score: ${top.compositeScore.toFixed(1)}/100). `;
    }

    if (topMatched.length > 0) {
      body += `NCL pipeline brands exhibiting at this show include ${topMatched.map(e => e.brandName).join(', ')}. `;
      body += `Priority approach: lead with the NI dual-market routing pitch, emphasising Windsor Framework regulatory clarity and cost-efficiency versus Rotterdam and Hamburg sea freight alternatives. `;
    } else {
      body += `No current pipeline brands have been confirmed exhibiting. Focus should be on brand discovery and pipeline enrichment — gather brand profiles, revenue indicators, and EU ambition signals from exhibitors in the relevant categories. `;
    }

    if (gapCorridors.length > 0) {
      const gaps = gapCorridors.map(d => `${CATEGORY_LABELS[d.category] ?? d.category} in ${COUNTRY_NAMES[d.countryCode] ?? d.countryCode}`).join(' and ');
      body += `Distributor coverage gaps have been identified in ${gaps} — target exhibitors in these categories to fill critical broker network gaps NCL is positioned to address. `;
    }

    body += `Follow-up priorities after the show: log all brand contacts in the NCL pipeline, score new exhibitors discovered on-site, and flag any brands with composite scores above 70 for outreach campaign consideration in the next cycle.`;
    return body;
  }

  // ── Main run ──────────────────────────────────────────────────────────────

  async run(): Promise<TradeShowPlaybookResult> {
    logger.info({ agent: 'TradeShowPlaybookAgent' }, 'Starting trade show playbook run');

    const shows = await this.fetchUpcomingShows();
    if (shows.length === 0) {
      logger.info({ agent: 'TradeShowPlaybookAgent' }, 'No upcoming shows — skipping');
      return { showsProcessed: 0, playbooksWritten: 0, exhibitorMatchRate: 0, prospectCardsGenerated: 0 };
    }

    let playbooksWritten        = 0;
    let totalExhibitorCount     = 0;
    let totalMatchedExhibitors  = 0;
    let totalProspectCards      = 0;

    for (const show of shows) {
      const matchedCategories = this.matchShowCategories(show.categories ?? []);
      if (matchedCategories.length === 0) {
        logger.info({ agent: 'TradeShowPlaybookAgent', show: show.name }, 'No NCL category match — skipping');
        continue;
      }

      // Parallel fetches: exhibitors, corridor scores, pipeline brands
      const [exhibitorRows, corridors, topPipelineBrands] = await Promise.all([
        this.fetchExhibitors(show.id),
        this.fetchCorridorScores(matchedCategories),
        this.fetchTopPipelineBrands(matchedCategories),
      ]);

      const exhibitorNames   = exhibitorRows.map(e => e.brandName);
      totalExhibitorCount   += exhibitorNames.length;

      // Exhibitor×Brand cross-reference
      const brandMatchMap    = await this.matchExhibitorsToBrands(exhibitorNames, matchedCategories);

      // Build per-exhibitor match records
      const exhibitorMatches: ExhibitorMatch[] = exhibitorNames.map(name => {
        const match    = brandMatchMap.get(name);
        const score    = match?.bestScore ?? null;
        const hasShopify = !!match?.shopifyStoreUrl;
        return {
          brandName:      name,
          brandId:        match?.id ?? null,
          compositeScore: score?.compositeScore ?? null,
          brandFitScore:  score?.brandFitScore  ?? null,
          niScore:        score?.niScore        ?? null,
          annualRevenue:  match?.annualRevenueEstimate ?? null,
          euPresence:     match?.euPresence     ?? null,
          hasShopify,
          pitchAngle:     buildPitchAngle({ compositeScore: score?.compositeScore ?? null, euPresence: match?.euPresence ?? null, hasShopify }),
        };
      });

      const matchedInPipeline = exhibitorMatches.filter(e => e.brandId !== null);
      totalMatchedExhibitors += matchedInPipeline.length;
      totalProspectCards     += matchedInPipeline.length;

      const unmatchedExhibitors = exhibitorMatches.filter(e => e.brandId === null).map(e => e.brandName);

      // Distributor coverage for matched corridors
      const distributorCoverage = await this.fetchDistributorCoverage(
        corridors.map(c => ({ category: c.category, countryCode: c.countryCode })),
      );

      // Build context string and generate narrative
      const context = this.buildContext({
        show, matchedCategories, corridors, exhibitorMatches, unmatchedExhibitors,
        distributorCoverage, topPipelineBrands, totalExhibitors: exhibitorNames.length,
      });

      const instruction =
        'Write a 500–700 word trade show playbook for the NCL commercial team structured as five paragraphs: ' +
        '(1) Show Strategic Overview — why this show matters for NCL\'s EU corridor strategy, ' +
        '(2) Priority Brands — the top 5 exhibitors to approach with specific conversation starters ' +
        'and NI routing pitch angles based on their scoring data and distributor gap context, ' +
        '(3) Distributor Intelligence — which corridors have coverage gaps this show can help fill ' +
        'and how to position NCL\'s broker role in conversations, ' +
        '(4) Pipeline Integration — how pipeline brands not exhibiting can be used to benchmark ' +
        'the exhibitor pool and sharpen NCL\'s outreach targeting after the show, ' +
        '(5) Meeting Strategy — day-by-day priorities and three specific follow-up actions. ' +
        'Plain prose, commercially direct, no bullet points.';

      const narrative = await this.callDeepSeek(context, instruction)
        ?? this.tplPlaybook({ show, matchedCategories, corridors, exhibitorMatches, distributorCoverage });

      // Upsert — one active playbook per show
      await db.insert(tradeShowPlaybooks)
        .values({
          id:                  randomUUID(),
          tradeShowId:         show.id,
          matchedCategories,
          relevantCorridors:   corridors    as unknown as Record<string, unknown>,
          exhibitorMatches:    exhibitorMatches as unknown as Record<string, unknown>,
          distributorCoverage: distributorCoverage as unknown as Record<string, unknown>,
          topPipelineBrands:   topPipelineBrands as unknown as Record<string, unknown>,
          totalExhibitors:     exhibitorNames.length,
          matchedExhibitors:   matchedInPipeline.length,
          narrative,
          status:              'draft',
          generatedAt:         new Date(),
        })
        .onConflictDoUpdate({
          target: [tradeShowPlaybooks.tradeShowId],
          set: {
            matchedCategories,
            relevantCorridors:   corridors    as unknown as Record<string, unknown>,
            exhibitorMatches:    exhibitorMatches as unknown as Record<string, unknown>,
            distributorCoverage: distributorCoverage as unknown as Record<string, unknown>,
            topPipelineBrands:   topPipelineBrands as unknown as Record<string, unknown>,
            totalExhibitors:     exhibitorNames.length,
            matchedExhibitors:   matchedInPipeline.length,
            narrative,
            generatedAt:         new Date(),
          },
        });

      playbooksWritten++;
      logger.info(
        { agent: 'TradeShowPlaybookAgent', show: show.name, matchedCategories, matchedExhibitors: matchedInPipeline.length, totalExhibitors: exhibitorNames.length },
        'Playbook written',
      );
    }

    const exhibitorMatchRate = totalExhibitorCount > 0 ? totalMatchedExhibitors / totalExhibitorCount : 0;

    await db.insert(agentOutputs).values({
      agentType:  'trade_show_playbook',
      outputData: {
        runAt:                  new Date().toISOString(),
        showsProcessed:         shows.length,
        playbooksWritten,
        exhibitorMatchRate,
        prospectCardsGenerated: totalProspectCards,
      } as unknown as Record<string, unknown>,
      relatedEntityIds: [],
    });

    logger.info(
      {
        agent:                  'TradeShowPlaybookAgent',
        showsProcessed:         shows.length,
        playbooksWritten,
        exhibitorMatchRate:     exhibitorMatchRate.toFixed(2),
        prospectCardsGenerated: totalProspectCards,
      },
      'Trade show playbook run complete',
    );

    return { showsProcessed: shows.length, playbooksWritten, exhibitorMatchRate, prospectCardsGenerated: totalProspectCards };
  }
}
