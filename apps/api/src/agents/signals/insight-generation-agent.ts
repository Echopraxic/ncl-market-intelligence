// src/agents/signals/insight-generation-agent.ts
//
// InsightGenerationAgent — Phase 3
//
// Generates four insight types from scored opportunities and signals:
//
//   opportunity_alert   — corridors or brands with compositeScore >= 80
//   market_brief        — top 10 corridors by composite score, full analysis
//   trade_show_playbook — per upcoming trade show, brand intercept strategy
//   weekly_report       — one executive digest per run (max one per 7 days)
//
// Each insight body = DeepSeek narrative paragraph + rule-based evidence block.
// Falls back to a template body when DEEPSEEK_API_KEY is absent or the call fails.
//
// Deduplication: any insight whose title was written within the last 7 days is
// skipped. Titles are deterministic per subject (corridor, brand, show, week
// number), so this naturally enforces a per-subject cooldown.

import { db } from '../../db/index.js';
import {
  insights,
  opportunityScores,
  brands,
  trends,
  tradeShows,
  tradeShowExhibitors,
  opportunityCorrelations,
} from '../../db/schema.js';
import { and, desc, gte, isNull, isNotNull, inArray, eq, sql } from 'drizzle-orm';
import { logger } from '../../lib/logger.js';
import scoringWeights from '../../config/scoring-weights.json' with { type: 'json' };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEDUP_WINDOW_DAYS   = 7;
const ALERT_THRESHOLD     = scoringWeights.thresholds.opportunityAlertScore; // 80
const TOP_CORRIDORS_LIMIT = 10;
const MAX_BRAND_ALERTS    = 20;
const DEEPSEEK_API_URL    = 'https://api.deepseek.com/v1/chat/completions';
const DEEPSEEK_MODEL      = 'deepseek-chat';

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
// Types
// ---------------------------------------------------------------------------

export interface InsightGenerationResult {
  opportunityAlerts: number;
  marketBriefs:      number;
  tradeShowPlaybooks: number;
  weeklyReport:      number;
  total:             number;
}

interface RunStats {
  alerts:   number;
  briefs:   number;
  playbooks: number;
}

// ---------------------------------------------------------------------------
// InsightGenerationAgent
// ---------------------------------------------------------------------------

export class InsightGenerationAgent {

  // ── 1. Deduplication ──────────────────────────────────────────────────────

  private async hasRecentInsight(title: string): Promise<boolean> {
    const cutoff = new Date(Date.now() - DEDUP_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const rows = await db
      .select({ id: insights.id })
      .from(insights)
      .where(and(eq(insights.title, title), gte(insights.createdAt, cutoff)))
      .limit(1);
    return rows.length > 0;
  }

  private async writeInsight(params: {
    type:  'opportunity_alert' | 'market_brief' | 'trade_show_playbook' | 'weekly_report';
    title: string;
    body:  string;
  }): Promise<void> {
    await db.insert(insights).values({
      type:   params.type,
      title:  params.title,
      body:   params.body,
      status: 'draft',
    });
  }

  // ── 2. DeepSeek narrative call ─────────────────────────────────────────────

  private async callDeepSeek(context: string, instruction: string): Promise<string | null> {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return null;

    const system =
      'You are an EU market intelligence analyst for North Channel Logistics (NCL), ' +
      'a freight operator that uses Northern Ireland as a dual-access corridor to both ' +
      'the EU single market and the UK under the Windsor Framework. ' +
      'Write concise, commercially direct insights for US consumer brands considering EU expansion. ' +
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
          max_tokens:  900,
        }),
      });

      if (!res.ok) {
        logger.warn({ agent: 'InsightGenerationAgent', status: res.status }, 'DeepSeek returned non-200 — using template');
        return null;
      }

      const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
      return data.choices[0]?.message?.content?.trim() ?? null;
    } catch (err) {
      logger.warn({ agent: 'InsightGenerationAgent', err }, 'DeepSeek call failed — using template');
      return null;
    }
  }

  // ── 3. Supporting data fetchers ───────────────────────────────────────────

  private async fetchTrendTiers(
    corridors: Array<{ category: string; countryCode: string }>,
  ): Promise<Map<string, string>> {
    if (corridors.length === 0) return new Map();
    const cutoff     = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const categories = [...new Set(corridors.map(c => c.category))];
    const countries  = [...new Set(corridors.map(c => c.countryCode))];

    const rows = await db
      .select({ category: trends.category, countryCode: trends.countryCode, opportunityTier: trends.opportunityTier, createdAt: trends.createdAt })
      .from(trends)
      .where(and(gte(trends.createdAt, cutoff), inArray(trends.category, categories), inArray(trends.countryCode, countries)));

    // Keep most recent tier per corridor
    const latestByKey = new Map<string, typeof rows[0]>();
    for (const row of rows) {
      const key = `${row.category}:${row.countryCode}`;
      const existing = latestByKey.get(key);
      if (!existing || row.createdAt > existing.createdAt) latestByKey.set(key, row);
    }

    const result = new Map<string, string>();
    for (const [key, row] of latestByKey) {
      if (row.opportunityTier) result.set(key, row.opportunityTier);
    }
    return result;
  }

  private async fetchCompoundSignals(
    corridors: Array<{ category: string; countryCode: string }>,
  ): Promise<Map<string, string[]>> {
    if (corridors.length === 0) return new Map();
    const categories = [...new Set(corridors.map(c => c.category))];
    const countries  = [...new Set(corridors.map(c => c.countryCode))];

    const rows = await db
      .select({ category: opportunityCorrelations.category, countryCode: opportunityCorrelations.countryCode, compoundSignals: opportunityCorrelations.compoundSignals })
      .from(opportunityCorrelations)
      .where(and(inArray(opportunityCorrelations.category, categories), inArray(opportunityCorrelations.countryCode, countries)));

    const result = new Map<string, string[]>();
    for (const row of rows) result.set(`${row.category}:${row.countryCode}`, row.compoundSignals ?? []);
    return result;
  }

  private async fetchTopBrandsByCategory(): Promise<Map<string, Array<{ name: string; score: number }>>> {
    const rows = await db
      .select({ brandName: brands.name, category: opportunityScores.category, compositeScore: opportunityScores.compositeScore })
      .from(opportunityScores)
      .innerJoin(brands, eq(opportunityScores.brandId, brands.id))
      .where(isNotNull(opportunityScores.brandId))
      .orderBy(desc(opportunityScores.compositeScore))
      .limit(50);

    const result = new Map<string, Array<{ name: string; score: number }>>();
    for (const row of rows) {
      const list = result.get(row.category) ?? [];
      list.push({ name: row.brandName, score: row.compositeScore });
      result.set(row.category, list);
    }
    return result;
  }

  // ── 4. Context builders ───────────────────────────────────────────────────

  private corridorContext(p: {
    category: string; countryCode: string;
    compositeScore: number; categoryScore: number; brandScore: number; niScore: number;
    factors: Record<string, unknown>; trendTier?: string; compoundSignals: string[];
  }): string {
    const inputs = (p.factors?.inputs ?? {}) as Record<string, unknown>;
    const ni     = (p.factors?.ni     ?? {}) as Record<string, unknown>;
    const lines  = [
      `CORRIDOR: ${CATEGORY_LABELS[p.category] ?? p.category} × ${COUNTRY_NAMES[p.countryCode] ?? p.countryCode}`,
      `Composite Score: ${p.compositeScore.toFixed(1)}/100  (Category ${p.categoryScore.toFixed(1)} | Brand-proxy ${p.brandScore.toFixed(1)} | NI ${p.niScore.toFixed(1)})`,
    ];
    if (p.trendTier)                          lines.push(`Opportunity Tier: ${p.trendTier}`);
    if (typeof inputs.gapScore === 'number')  lines.push(`Demand-Supply Gap Score: ${inputs.gapScore.toFixed(1)}`);
    if (typeof inputs.demandPercentile === 'number') lines.push(`Demand Percentile: ${(inputs.demandPercentile * 100).toFixed(0)}th`);
    if (typeof inputs.usBrandEntryConfidence === 'number' && inputs.usBrandEntryConfidence > 0)
      lines.push(`Retailer US-Brand-Entry Signal: ${(inputs.usBrandEntryConfidence * 100).toFixed(0)}% confidence`);
    if (typeof ni.vatAdvantage === 'number' && ni.vatAdvantage > 0)
      lines.push(`NI VAT Advantage: ${(ni.vatAdvantage as number).toFixed(2)}`);
    if (typeof ni.distributionEfficiency === 'number' && ni.distributionEfficiency > 0)
      lines.push(`NI Distribution Efficiency: ${(ni.distributionEfficiency as number).toFixed(2)}`);
    if (p.compoundSignals.length > 0) {
      lines.push('Cross-Signal Intelligence:');
      p.compoundSignals.slice(0, 3).forEach(s => lines.push(`  • ${s}`));
    }
    return lines.join('\n');
  }

  private brandContext(p: {
    brandName: string; category: string; countryCode: string;
    compositeScore: number; brandFitScore: number; niScore: number; categoryScore: number;
    factors: Record<string, unknown>;
  }): string {
    const inputs  = (p.factors?.inputs ?? {}) as Record<string, unknown>;
    const bfactors = (p.factors?.brand ?? {}) as Record<string, unknown>;
    const ni      = (p.factors?.ni    ?? {}) as Record<string, unknown>;
    const lines   = [
      `BRAND: ${p.brandName}`,
      `Target Corridor: ${CATEGORY_LABELS[p.category] ?? p.category} × ${COUNTRY_NAMES[p.countryCode] ?? p.countryCode}`,
      `Composite Score: ${p.compositeScore.toFixed(1)}/100  (Brand Fit ${p.brandFitScore.toFixed(1)} | NI Suitability ${p.niScore.toFixed(1)} | Category ${p.categoryScore.toFixed(1)})`,
    ];
    if (typeof bfactors.categoryMatchScore === 'number')
      lines.push(`Category Match: ${(bfactors.categoryMatchScore as number * 100).toFixed(0)}%`);
    if (typeof bfactors.revenueTierScore === 'number')
      lines.push(`Revenue Tier Score: ${(bfactors.revenueTierScore as number).toFixed(2)} (mid-market 1.0 = ideal)`);
    if (inputs.hasShopify != null)  lines.push(`Shopify/DTC Presence: ${inputs.hasShopify ? 'Yes' : 'No'}`);
    if (inputs.euPresence != null)  lines.push(`Existing EU Presence: ${inputs.euPresence ? 'Yes (penalty applied)' : 'No — US-only'}`);
    if (typeof ni.usOnlyDistribution === 'number')
      lines.push(`Distribution Gap (NCL Value): ${(ni.usOnlyDistribution as number).toFixed(2)}`);
    if (typeof ni.avgNiSignal === 'number' && ni.avgNiSignal > 0)
      lines.push(`NI Corridor Signal: ${(ni.avgNiSignal as number).toFixed(2)}`);
    return lines.join('\n');
  }

  private tradeShowContext(p: {
    show: { name: string | null; location: string | null; startDate: Date | null; endDate: Date | null };
    matchedCategories: string[];
    relevantCorridors: Array<{ category: string; countryCode: string; compositeScore: number }>;
    exhibitors: Array<{ brandName: string }>;
    topBrands: Array<{ name: string; score: number }>;
  }): string {
    const lines = [
      `TRADE SHOW: ${p.show.name ?? 'Unknown'}`,
      `Location: ${p.show.location ?? 'TBC'}`,
      `Dates: ${p.show.startDate?.toLocaleDateString('en-GB') ?? 'TBC'} – ${p.show.endDate?.toLocaleDateString('en-GB') ?? 'TBC'}`,
      `NCL-Relevant Categories: ${p.matchedCategories.map(c => CATEGORY_LABELS[c] ?? c).join(', ') || 'None matched'}`,
    ];
    if (p.relevantCorridors.length > 0) {
      lines.push('Active Opportunity Corridors:');
      p.relevantCorridors.forEach(c =>
        lines.push(`  • ${CATEGORY_LABELS[c.category] ?? c.category} × ${COUNTRY_NAMES[c.countryCode] ?? c.countryCode}: ${c.compositeScore.toFixed(1)}/100`)
      );
    }
    if (p.exhibitors.length > 0)
      lines.push(`Exhibitors (${p.exhibitors.length}): ${p.exhibitors.slice(0, 12).map(e => e.brandName).join(', ')}`);
    if (p.topBrands.length > 0) {
      lines.push('Top Scored Brands in Matching Categories:');
      p.topBrands.forEach(b => lines.push(`  • ${b.name}: ${b.score.toFixed(1)}/100`));
    }
    return lines.join('\n');
  }

  private weeklyDigestContext(p: {
    weekNum: number; year: number;
    topCorridors: Array<{ category: string; countryCode: string; compositeScore: number }>;
    brandsAboveThreshold: number;
    upcomingShows: Array<{ name: string | null; startDate: Date | null }>;
    recentTrends: Array<{ category: string; countryCode: string; opportunityTier: string | null; growthRate: number }>;
    stats: RunStats;
  }): string {
    const lines = [
      `WEEKLY DIGEST: W${p.weekNum} ${p.year}`,
      `Insights generated this run — Alerts: ${p.stats.alerts} | Briefs: ${p.stats.briefs} | Playbooks: ${p.stats.playbooks}`,
      '',
      'Top EU Corridors (composite score):',
    ];
    p.topCorridors.forEach(c =>
      lines.push(`  • ${CATEGORY_LABELS[c.category] ?? c.category} × ${COUNTRY_NAMES[c.countryCode] ?? c.countryCode}: ${c.compositeScore.toFixed(1)}/100`)
    );
    lines.push(`\nBrands above outreach threshold (≥${ALERT_THRESHOLD}): ${p.brandsAboveThreshold}`);
    if (p.upcomingShows.length > 0) {
      lines.push('\nUpcoming Trade Shows:');
      p.upcomingShows.forEach(s => lines.push(`  • ${s.name ?? 'Unknown'} — ${s.startDate?.toLocaleDateString('en-GB') ?? 'TBC'}`));
    }
    if (p.recentTrends.length > 0) {
      lines.push('\nTop Detected Trends (90-day window):');
      p.recentTrends.forEach(t =>
        lines.push(`  • ${CATEGORY_LABELS[t.category] ?? t.category} × ${COUNTRY_NAMES[t.countryCode] ?? t.countryCode}: ${((t.growthRate ?? 0) * 100).toFixed(0)}% [${t.opportunityTier ?? 'unclassified'}]`)
      );
    }
    return lines.join('\n');
  }

  // ── 5. Template fallbacks ─────────────────────────────────────────────────

  private tplCorridorAlert(category: string, countryCode: string, score: number, tier?: string): string {
    const cat = CATEGORY_LABELS[category] ?? category;
    const country = COUNTRY_NAMES[countryCode] ?? countryCode;
    return `The ${cat} corridor in ${country} has reached a composite score of ${score.toFixed(1)}/100${tier ? `, classified as ${tier}-tier growth` : ''}. ` +
      `Demand-supply gap analysis and NI routing signals support immediate commercial attention. ` +
      `Northern Ireland's dual-market access position makes this one of the most cost-efficient EU entry routes available to US brands. ` +
      `Recommended action: initiate corridor assessment and identify target brands for outreach.`;
  }

  private tplBrandAlert(brandName: string, category: string, countryCode: string, score: number): string {
    const cat = CATEGORY_LABELS[category] ?? category;
    const country = COUNTRY_NAMES[countryCode] ?? countryCode;
    return `${brandName} has achieved a composite opportunity score of ${score.toFixed(1)}/100 for the ${cat} corridor in ${country}. ` +
      `Brand fit indicators — including category alignment, revenue tier, and DTC presence — indicate strong EU expansion potential via NCL's Northern Ireland routing. ` +
      `Recommended action: prioritise ${brandName} for personalised outreach in the next campaign cycle.`;
  }

  private tplMarketBrief(category: string, countryCode: string, score: number, tier?: string): string {
    const cat = CATEGORY_LABELS[category] ?? category;
    const country = COUNTRY_NAMES[countryCode] ?? countryCode;
    return `The ${cat} market in ${country} presents a ${tier ?? 'notable'}-tier opportunity with a composite score of ${score.toFixed(1)}/100. ` +
      `Trade flow and demand-supply metrics indicate an underserved import corridor where US brand penetration remains below equilibrium. ` +
      `NCL's Northern Ireland routing offers a regulatory-efficient and competitively priced entry channel. ` +
      `Distributor coverage analysis suggests immediate broker relationship opportunities that NCL is positioned to facilitate.`;
  }

  private tplTradeShowPlaybook(name: string, location: string | null, categories: string[]): string {
    const catList = categories.map(c => CATEGORY_LABELS[c] ?? c).join(', ') || 'general consumer goods';
    return `${name}${location ? ` in ${location}` : ''} is a key intercept opportunity for NCL's brand acquisition pipeline. ` +
      `The show covers ${catList} — categories where active EU demand-supply gaps have been identified. ` +
      `Priority: engage exhibitors in high-scoring corridors, pitch NI dual-market routing as a scalable EU entry solution, ` +
      `and gather distributor relationship data for the pipeline intelligence database.`;
  }

  private tplWeeklyDigest(corridors: Array<{ category: string; countryCode: string; compositeScore: number }>, brandsAbove: number): string {
    const top = corridors.slice(0, 3)
      .map(c => `${CATEGORY_LABELS[c.category] ?? c.category} in ${COUNTRY_NAMES[c.countryCode] ?? c.countryCode} (${c.compositeScore.toFixed(1)})`)
      .join(', ');
    return `This week's scan has identified strong EU expansion signals across multiple corridors. ` +
      `Top opportunities: ${top || 'pending data'}. ` +
      `${brandsAbove} brand${brandsAbove !== 1 ? 's' : ''} ${brandsAbove === 1 ? 'has' : 'have'} crossed the outreach threshold. ` +
      `NCL's NI routing pipeline is well-positioned to convert these signals into commercial engagements. ` +
      `Review the attached opportunity alerts and market briefs for corridor analysis and brand outreach priorities.`;
  }

  // ── 6. Trade show category matching ──────────────────────────────────────

  private matchShowCategories(showCategories: string[]): string[] {
    const matched = new Set<string>();
    const aliases = scoringWeights.categoryAliases as Record<string, string[]>;
    const keywords = scoringWeights.tradeShowCategoryKeywords as Record<string, string[]>;

    for (const showCat of showCategories) {
      const lower = showCat.toLowerCase().trim();
      for (const nclKey of Object.keys(aliases)) {
        const isMatch =
          (aliases[nclKey] ?? []).some(a => lower === a || lower.includes(a) || a.includes(lower)) ||
          (keywords[nclKey] ?? []).some(kw => lower.includes(kw));
        if (isMatch) matched.add(nclKey);
      }
    }
    return [...matched];
  }

  // ── 7. Insight body assembler ─────────────────────────────────────────────

  private assembleBody(narrative: string, context: string): string {
    return `${narrative}\n\n---\nEvidence Summary:\n${context}`;
  }

  // ── 8. Insight type generators ────────────────────────────────────────────

  private async generateOpportunityAlerts(): Promise<number> {
    // Corridor-level rows above threshold
    const corridorRows = await db
      .select({
        category: opportunityScores.category, countryCode: opportunityScores.countryCode,
        compositeScore: opportunityScores.compositeScore,
        categoryOpportunityScore: opportunityScores.categoryOpportunityScore,
        brandFitScore: opportunityScores.brandFitScore, niSuitabilityPreScore: opportunityScores.niSuitabilityPreScore,
        scoringFactors: opportunityScores.scoringFactors,
      })
      .from(opportunityScores)
      .where(and(isNull(opportunityScores.brandId), gte(opportunityScores.compositeScore, ALERT_THRESHOLD)))
      .orderBy(desc(opportunityScores.compositeScore));

    // Brand-level rows above threshold
    const brandRows = await db
      .select({
        brandName: brands.name,
        category: opportunityScores.category, countryCode: opportunityScores.countryCode,
        compositeScore: opportunityScores.compositeScore,
        categoryOpportunityScore: opportunityScores.categoryOpportunityScore,
        brandFitScore: opportunityScores.brandFitScore, niSuitabilityPreScore: opportunityScores.niSuitabilityPreScore,
        scoringFactors: opportunityScores.scoringFactors,
      })
      .from(opportunityScores)
      .innerJoin(brands, eq(opportunityScores.brandId, brands.id))
      .where(and(isNotNull(opportunityScores.brandId), gte(opportunityScores.compositeScore, ALERT_THRESHOLD)))
      .orderBy(desc(opportunityScores.compositeScore))
      .limit(MAX_BRAND_ALERTS);

    const allCorridors = [
      ...corridorRows.map(r => ({ category: r.category, countryCode: r.countryCode })),
      ...brandRows.map(r => ({ category: r.category, countryCode: r.countryCode })),
    ];
    const [trendTierMap, correlationMap] = await Promise.all([
      this.fetchTrendTiers(allCorridors),
      this.fetchCompoundSignals(allCorridors),
    ]);

    let count = 0;

    for (const row of corridorRows) {
      const key   = `${row.category}:${row.countryCode}`;
      const title = `Opportunity Alert: ${CATEGORY_LABELS[row.category] ?? row.category} × ${COUNTRY_NAMES[row.countryCode] ?? row.countryCode}`;
      if (await this.hasRecentInsight(title)) continue;

      const ctx = this.corridorContext({
        category: row.category, countryCode: row.countryCode,
        compositeScore: row.compositeScore,
        categoryScore: row.categoryOpportunityScore, brandScore: row.brandFitScore, niScore: row.niSuitabilityPreScore,
        factors: (row.scoringFactors ?? {}) as Record<string, unknown>,
        trendTier: trendTierMap.get(key),
        compoundSignals: correlationMap.get(key) ?? [],
      });

      const narrative = await this.callDeepSeek(ctx,
        'Write a 150–200 word opportunity alert. Lead with the strongest signal. ' +
        'Be specific about why Northern Ireland routing creates value here. End with one recommended next action for NCL.'
      ) ?? this.tplCorridorAlert(row.category, row.countryCode, row.compositeScore, trendTierMap.get(key));

      await this.writeInsight({ type: 'opportunity_alert', title, body: this.assembleBody(narrative, ctx) });
      count++;
    }

    for (const row of brandRows) {
      const title = `Brand Opportunity: ${row.brandName} → ${CATEGORY_LABELS[row.category] ?? row.category} × ${COUNTRY_NAMES[row.countryCode] ?? row.countryCode}`;
      if (await this.hasRecentInsight(title)) continue;

      const ctx = this.brandContext({
        brandName: row.brandName, category: row.category, countryCode: row.countryCode,
        compositeScore: row.compositeScore, brandFitScore: row.brandFitScore,
        niScore: row.niSuitabilityPreScore, categoryScore: row.categoryOpportunityScore,
        factors: (row.scoringFactors ?? {}) as Record<string, unknown>,
      });

      const narrative = await this.callDeepSeek(ctx,
        'Write a 150–200 word opportunity alert for this specific brand. ' +
        'Explain why this brand is a strong EU expansion candidate and what NCL\'s NI routing adds. ' +
        'End with a specific recommended outreach angle.'
      ) ?? this.tplBrandAlert(row.brandName, row.category, row.countryCode, row.compositeScore);

      await this.writeInsight({ type: 'opportunity_alert', title, body: this.assembleBody(narrative, ctx) });
      count++;
    }

    return count;
  }

  private async generateMarketBriefs(): Promise<number> {
    const corridors = await db
      .select({
        category: opportunityScores.category, countryCode: opportunityScores.countryCode,
        compositeScore: opportunityScores.compositeScore,
        categoryOpportunityScore: opportunityScores.categoryOpportunityScore,
        brandFitScore: opportunityScores.brandFitScore, niSuitabilityPreScore: opportunityScores.niSuitabilityPreScore,
        scoringFactors: opportunityScores.scoringFactors,
      })
      .from(opportunityScores)
      .where(isNull(opportunityScores.brandId))
      .orderBy(desc(opportunityScores.compositeScore))
      .limit(TOP_CORRIDORS_LIMIT);

    if (corridors.length === 0) return 0;

    const [trendTierMap, correlationMap] = await Promise.all([
      this.fetchTrendTiers(corridors.map(r => ({ category: r.category, countryCode: r.countryCode }))),
      this.fetchCompoundSignals(corridors.map(r => ({ category: r.category, countryCode: r.countryCode }))),
    ]);

    let count = 0;

    for (const row of corridors) {
      const key   = `${row.category}:${row.countryCode}`;
      const title = `Market Brief: ${CATEGORY_LABELS[row.category] ?? row.category} in ${COUNTRY_NAMES[row.countryCode] ?? row.countryCode}`;
      if (await this.hasRecentInsight(title)) continue;

      const ctx = this.corridorContext({
        category: row.category, countryCode: row.countryCode,
        compositeScore: row.compositeScore,
        categoryScore: row.categoryOpportunityScore, brandScore: row.brandFitScore, niScore: row.niSuitabilityPreScore,
        factors: (row.scoringFactors ?? {}) as Record<string, unknown>,
        trendTier: trendTierMap.get(key),
        compoundSignals: correlationMap.get(key) ?? [],
      });

      const narrative = await this.callDeepSeek(ctx,
        'Write a 300–400 word market brief in four paragraphs: ' +
        '(1) demand drivers and growth context, ' +
        '(2) competitive landscape and supply-side gaps, ' +
        '(3) Northern Ireland routing advantage and logistics fit, ' +
        '(4) recommended entry strategy for NCL\'s brand partners. ' +
        'Commercially direct language; no bullet points.'
      ) ?? this.tplMarketBrief(row.category, row.countryCode, row.compositeScore, trendTierMap.get(key));

      await this.writeInsight({ type: 'market_brief', title, body: this.assembleBody(narrative, ctx) });
      count++;
    }

    return count;
  }

  private async generateTradeShowPlaybooks(): Promise<number> {
    const now   = new Date();
    const shows = await db
      .select({ id: tradeShows.id, name: tradeShows.name, location: tradeShows.location, countryCode: tradeShows.countryCode, startDate: tradeShows.startDate, endDate: tradeShows.endDate, categories: tradeShows.categories })
      .from(tradeShows)
      .where(and(isNotNull(tradeShows.startDate), gte(tradeShows.startDate!, now)));

    if (shows.length === 0) return 0;

    const corridorScores = await db
      .select({ category: opportunityScores.category, countryCode: opportunityScores.countryCode, compositeScore: opportunityScores.compositeScore })
      .from(opportunityScores)
      .where(isNull(opportunityScores.brandId))
      .orderBy(desc(opportunityScores.compositeScore));

    const topBrandsByCategory = await this.fetchTopBrandsByCategory();
    let count = 0;

    for (const show of shows) {
      const title = `Trade Show Playbook: ${show.name}`;
      if (await this.hasRecentInsight(title)) continue;

      const matchedCategories = this.matchShowCategories(show.categories ?? []);
      const relevantCorridors = corridorScores.filter(c => matchedCategories.includes(c.category)).slice(0, 5);
      const exhibitors = await db
        .select({ brandName: tradeShowExhibitors.brandName })
        .from(tradeShowExhibitors)
        .where(eq(tradeShowExhibitors.tradeShowId, show.id))
        .limit(20);
      const topBrands = matchedCategories
        .flatMap(cat => (topBrandsByCategory.get(cat) ?? []).slice(0, 3))
        .slice(0, 10);

      const ctx = this.tradeShowContext({ show, matchedCategories, relevantCorridors, exhibitors, topBrands });

      const narrative = await this.callDeepSeek(ctx,
        'Write a 300–400 word trade show playbook with four sections: ' +
        '(1) show overview and strategic relevance for NCL\'s pipeline, ' +
        '(2) priority brands to approach from the exhibitor list or scored pipeline, ' +
        '(3) category-specific talking points and NI routing pitch angles, ' +
        '(4) recommended meeting strategy and follow-up priorities. ' +
        'Specific and actionable; no bullet points.'
      ) ?? this.tplTradeShowPlaybook(show.name ?? 'Trade Show', show.location, matchedCategories);

      await this.writeInsight({ type: 'trade_show_playbook', title, body: this.assembleBody(narrative, ctx) });
      count++;
    }

    return count;
  }

  private async generateWeeklyReport(stats: RunStats): Promise<number> {
    const now     = new Date();
    const weekNum = this.isoWeekNumber(now);
    const year    = now.getFullYear();
    const title   = `NCL Weekly Intelligence Digest: W${weekNum} ${year}`;
    if (await this.hasRecentInsight(title)) return 0;

    const [topCorridors, brandsResult, upcomingShows, recentTrends] = await Promise.all([
      db.select({ category: opportunityScores.category, countryCode: opportunityScores.countryCode, compositeScore: opportunityScores.compositeScore })
        .from(opportunityScores).where(isNull(opportunityScores.brandId)).orderBy(desc(opportunityScores.compositeScore)).limit(5),
      db.select({ count: sql<number>`count(*)::int` })
        .from(opportunityScores).where(and(isNotNull(opportunityScores.brandId), gte(opportunityScores.compositeScore, ALERT_THRESHOLD))),
      db.select({ name: tradeShows.name, startDate: tradeShows.startDate })
        .from(tradeShows).where(and(isNotNull(tradeShows.startDate), gte(tradeShows.startDate!, now))).orderBy(tradeShows.startDate!).limit(3),
      db.select({ category: trends.category, countryCode: trends.countryCode, opportunityTier: trends.opportunityTier, growthRate: trends.growthRate })
        .from(trends).where(gte(trends.createdAt, new Date(Date.now() - 90 * 24 * 60 * 60 * 1000))).orderBy(desc(trends.growthRate)).limit(5),
    ]);

    const ctx = this.weeklyDigestContext({
      weekNum, year,
      topCorridors,
      brandsAboveThreshold: brandsResult[0]?.count ?? 0,
      upcomingShows,
      recentTrends,
      stats,
    });

    const narrative = await this.callDeepSeek(ctx,
      'Write a 500–700 word weekly intelligence digest structured as: ' +
      '(1) Executive Summary — 2–3 sentences on the week\'s most important signal, ' +
      '(2) Top 3 Opportunities — one paragraph each on the leading corridors, ' +
      '(3) Brand Pipeline — which brands are ready for outreach and why, ' +
      '(4) Trade Show Calendar — upcoming shows and their pipeline relevance, ' +
      '(5) Recommended Priorities — three specific actions for the NCL commercial team this week. ' +
      'Write as if briefing a commercial director before their Monday morning meeting.'
    ) ?? this.tplWeeklyDigest(topCorridors, brandsResult[0]?.count ?? 0);

    await this.writeInsight({ type: 'weekly_report', title, body: this.assembleBody(narrative, ctx) });
    return 1;
  }

  // ── 9. Utility ────────────────────────────────────────────────────────────

  private isoWeekNumber(date: Date): number {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  }

  // ── 10. Main run ──────────────────────────────────────────────────────────

  async run(): Promise<InsightGenerationResult> {
    logger.info({ agent: 'InsightGenerationAgent' }, 'Starting insight generation run');

    const opportunityAlerts   = await this.generateOpportunityAlerts();
    const marketBriefs        = await this.generateMarketBriefs();
    const tradeShowPlaybooks  = await this.generateTradeShowPlaybooks();

    const weeklyReport = await this.generateWeeklyReport({
      alerts:   opportunityAlerts,
      briefs:   marketBriefs,
      playbooks: tradeShowPlaybooks,
    });

    const total = opportunityAlerts + marketBriefs + tradeShowPlaybooks + weeklyReport;

    logger.info(
      { agent: 'InsightGenerationAgent', opportunityAlerts, marketBriefs, tradeShowPlaybooks, weeklyReport, total },
      'Insight generation complete',
    );

    return { opportunityAlerts, marketBriefs, tradeShowPlaybooks, weeklyReport, total };
  }
}
