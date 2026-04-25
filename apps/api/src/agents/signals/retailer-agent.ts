// src/agents/signals/retailer-agent.ts
//
// RetailerBehaviorAgent
//
// Rule engine (Option A) — analyses retailer_activities to detect:
//   • expansion    — ≥2 distinct retailers add the same category within 30 days
//   • rotation     — ≥2 retailers mark the same category as seasonal_rotation
//   • us_brand_entry — new_listing events where the brand can be inferred as US-origin
//
// DeepSeek synthesis (Option C) — for each country with ≥1 detected insight,
// a single batched prompt sends all rule findings to DeepSeek-chat, requesting
// a JSON synthesis with a natural-language narrative per insight.
// Synthesis is gracefully skipped if DEEPSEEK_API_KEY is absent or the API errors.
//
// Outputs are written to retailer_insights and agent_outputs tables.

import { db } from '../../db/index.js';
import {
  retailerActivities,
  brands,
  retailerInsights,
  agentOutputs,
} from '../../db/schema.js';
import { and, eq, gte, sql, inArray } from 'drizzle-orm';
import { logger } from '../../lib/logger.js';
import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RetailerActivityRow {
  id: string;
  retailerName: string;
  countryCode: string;
  activityType: 'new_listing' | 'category_expansion' | 'seasonal_rotation';
  category: string | null;
  details: unknown;
  detectedAt: Date;
}

interface RuleInsight {
  id: string;
  category: string;
  countryCode: string;
  patternType: 'expansion' | 'rotation' | 'us_brand_entry';
  retailerCount: number;
  evidenceIds: string[];
  confidence: number;
  ruleDetails: RuleDetails;
}

interface RuleDetails {
  retailerNames: string[];
  windowDays: number;
  activityCount: number;
  dateRange: { first: string; last: string };
  inferredUsBrands?: string[];
}

interface DeepSeekSynthesis {
  insights: Array<{
    category: string;
    countryCode: string;
    patternType: string;
    narrative: string;
  }>;
}

export interface RetailerRunResult {
  detected: number;
  withSynthesis: number;
  byPattern: { expansion: number; rotation: number; us_brand_entry: number };
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export class RetailerBehaviorAgent {
  private readonly WINDOW_DAYS = 30;
  private readonly MIN_RETAILER_COUNT = 2;

  async run(): Promise<RetailerRunResult> {
    logger.info('[RetailerAgent] Starting retailer behaviour analysis');

    const windowStart = new Date();
    windowStart.setDate(windowStart.getDate() - this.WINDOW_DAYS);

    // -----------------------------------------------------------------------
    // 1. Load all activities in the analysis window
    // -----------------------------------------------------------------------

    const activities = await db
      .select()
      .from(retailerActivities)
      .where(gte(retailerActivities.detectedAt, windowStart)) as RetailerActivityRow[];

    if (activities.length === 0) {
      logger.info('[RetailerAgent] No retailer activities in window — nothing to analyse');
      return { detected: 0, withSynthesis: 0, byPattern: { expansion: 0, rotation: 0, us_brand_entry: 0 } };
    }

    // -----------------------------------------------------------------------
    // 2. Run rule engine
    // -----------------------------------------------------------------------

    const insights: RuleInsight[] = [
      ...this.detectExpansions(activities),
      ...this.detectRotations(activities),
      ...await this.detectUsBrandEntries(activities),
    ];

    // -----------------------------------------------------------------------
    // 3. DeepSeek synthesis — batched per country
    // -----------------------------------------------------------------------

    let synthesisCount = 0;
    const byCountry = groupBy(insights, i => i.countryCode);

    for (const [countryCode, countryInsights] of byCountry) {
      try {
        const synthesis = await this.synthesiseWithDeepSeek(countryCode, countryInsights);
        if (synthesis) {
          synthesisCount += synthesis.insights.length;
          // Attach AI narrative to matching rule insights
          for (const si of synthesis.insights) {
            const match = countryInsights.find(
              i => i.category === si.category && i.patternType === si.patternType,
            );
            if (match) {
              (match as RuleInsight & { aiSynthesis?: string }).aiSynthesis = si.narrative;
            }
          }
        }
      } catch (err) {
        logger.warn(
          { countryCode, error: err instanceof Error ? err.message : String(err) },
          '[RetailerAgent] DeepSeek synthesis failed for country — persisting without AI narrative',
        );
      }
    }

    // -----------------------------------------------------------------------
    // 4. Persist to retailer_insights and agent_outputs
    // -----------------------------------------------------------------------

    await this.persist(insights);

    const counts = {
      expansion: insights.filter(i => i.patternType === 'expansion').length,
      rotation: insights.filter(i => i.patternType === 'rotation').length,
      us_brand_entry: insights.filter(i => i.patternType === 'us_brand_entry').length,
    };

    logger.info(
      { detected: insights.length, withSynthesis: synthesisCount, ...counts },
      '[RetailerAgent] Analysis complete',
    );

    return { detected: insights.length, withSynthesis: synthesisCount, byPattern: counts };
  }

  // ---------------------------------------------------------------------------
  // Rule 1: Category expansion — ≥2 retailers add the same category within 30 days
  // ---------------------------------------------------------------------------

  private detectExpansions(activities: RetailerActivityRow[]): RuleInsight[] {
    const relevant = activities.filter(
      a => a.category && (a.activityType === 'new_listing' || a.activityType === 'category_expansion'),
    );

    const grouped = groupBy(relevant, a => `${a.countryCode}:${a.category}`);
    const insights: RuleInsight[] = [];

    for (const [key, rows] of grouped) {
      const [countryCode, ...catParts] = key.split(':');
      const category = catParts.join(':');
      const uniqueRetailers = new Set(rows.map(r => r.retailerName));

      if (uniqueRetailers.size < this.MIN_RETAILER_COUNT) continue;

      const sorted = rows.sort((a, b) => a.detectedAt.getTime() - b.detectedAt.getTime());
      const retailerNames = Array.from(uniqueRetailers);

      // Confidence: scales with retailer count and recency of last activity
      const daysSinceLast = (Date.now() - sorted[sorted.length - 1].detectedAt.getTime()) / 86_400_000;
      const confidence = Math.min(0.5 + (uniqueRetailers.size - 2) * 0.1 + Math.max(0, (30 - daysSinceLast) / 30) * 0.2, 1.0);

      insights.push({
        id: randomUUID(),
        category,
        countryCode,
        patternType: 'expansion',
        retailerCount: uniqueRetailers.size,
        evidenceIds: rows.map(r => r.id),
        confidence: Math.round(confidence * 100) / 100,
        ruleDetails: {
          retailerNames,
          windowDays: this.WINDOW_DAYS,
          activityCount: rows.length,
          dateRange: {
            first: sorted[0].detectedAt.toISOString(),
            last: sorted[sorted.length - 1].detectedAt.toISOString(),
          },
        },
      });
    }

    return insights;
  }

  // ---------------------------------------------------------------------------
  // Rule 2: Seasonal rotation — ≥2 retailers rotate the same category
  // ---------------------------------------------------------------------------

  private detectRotations(activities: RetailerActivityRow[]): RuleInsight[] {
    const relevant = activities.filter(
      a => a.category && a.activityType === 'seasonal_rotation',
    );

    const grouped = groupBy(relevant, a => `${a.countryCode}:${a.category}`);
    const insights: RuleInsight[] = [];

    for (const [key, rows] of grouped) {
      const [countryCode, ...catParts] = key.split(':');
      const category = catParts.join(':');
      const uniqueRetailers = new Set(rows.map(r => r.retailerName));

      if (uniqueRetailers.size < this.MIN_RETAILER_COUNT) continue;

      const sorted = rows.sort((a, b) => a.detectedAt.getTime() - b.detectedAt.getTime());

      // Lower confidence for rotation — it's expected seasonal behaviour
      const confidence = Math.min(0.4 + (uniqueRetailers.size - 2) * 0.08, 0.85);

      insights.push({
        id: randomUUID(),
        category,
        countryCode,
        patternType: 'rotation',
        retailerCount: uniqueRetailers.size,
        evidenceIds: rows.map(r => r.id),
        confidence: Math.round(confidence * 100) / 100,
        ruleDetails: {
          retailerNames: Array.from(uniqueRetailers),
          windowDays: this.WINDOW_DAYS,
          activityCount: rows.length,
          dateRange: {
            first: sorted[0].detectedAt.toISOString(),
            last: sorted[sorted.length - 1].detectedAt.toISOString(),
          },
        },
      });
    }

    return insights;
  }

  // ---------------------------------------------------------------------------
  // Rule 3: US brand entry — new_listing events where brand appears US-origin
  //
  // US-origin inference heuristics (no external API needed):
  //   a) details.brandCountry === 'US'
  //   b) details.brandName matches a brand in our brands table with country='US'
  //   c) details.brandName ends with common US brand suffixes (Inc, LLC, Corp, Co.)
  //      AND no EU TLD / country prefix is found
  // ---------------------------------------------------------------------------

  private async detectUsBrandEntries(activities: RetailerActivityRow[]): Promise<RuleInsight[]> {
    const relevant = activities.filter(a => a.activityType === 'new_listing' && a.category);

    if (relevant.length === 0) return [];

    // Fetch all known US brands from our brands table for cross-reference
    const usBrandsInDb = await db
      .select({ name: brands.name })
      .from(brands)
      .where(eq(brands.country, 'US'));

    const usBrandNames = new Set(usBrandsInDb.map(b => b.name.toLowerCase()));
    const usSuffixes = /\b(inc|llc|corp|co\.|company|brands|foods|nutrition|wellness)\b/i;

    // Classify each activity as US-origin or not
    const usActivities = relevant.filter(a => this.isUsBrand(a, usBrandNames, usSuffixes));

    const grouped = groupBy(usActivities, a => `${a.countryCode}:${a.category}`);
    const insights: RuleInsight[] = [];

    for (const [key, rows] of grouped) {
      const [countryCode, ...catParts] = key.split(':');
      const category = catParts.join(':');
      const uniqueRetailers = new Set(rows.map(r => r.retailerName));

      if (uniqueRetailers.size < this.MIN_RETAILER_COUNT) continue;

      const sorted = rows.sort((a, b) => a.detectedAt.getTime() - b.detectedAt.getTime());
      const inferredBrands = [...new Set(rows.map(r => this.extractBrandName(r)).filter(Boolean))] as string[];

      const confidence = Math.min(0.55 + (uniqueRetailers.size - 2) * 0.1, 0.90);

      insights.push({
        id: randomUUID(),
        category,
        countryCode,
        patternType: 'us_brand_entry',
        retailerCount: uniqueRetailers.size,
        evidenceIds: rows.map(r => r.id),
        confidence: Math.round(confidence * 100) / 100,
        ruleDetails: {
          retailerNames: Array.from(uniqueRetailers),
          windowDays: this.WINDOW_DAYS,
          activityCount: rows.length,
          dateRange: {
            first: sorted[0].detectedAt.toISOString(),
            last: sorted[sorted.length - 1].detectedAt.toISOString(),
          },
          inferredUsBrands: inferredBrands.slice(0, 10),
        },
      });
    }

    return insights;
  }

  private isUsBrand(
    activity: RetailerActivityRow,
    usBrandNames: Set<string>,
    usSuffixes: RegExp,
  ): boolean {
    const details = activity.details as Record<string, unknown> | null;

    // Heuristic a: explicit country field
    if (typeof details?.brandCountry === 'string' && details.brandCountry.toUpperCase() === 'US') {
      return true;
    }

    const brandName = this.extractBrandName(activity);
    if (!brandName) return false;

    // Heuristic b: matches known US brand in our DB
    if (usBrandNames.has(brandName.toLowerCase())) return true;

    // Heuristic c: US corporate suffix, no EU indicator
    const euIndicator = /\b(gmbh|bv|sarl|srl|ltd|plc|ag|nv|oy|as|ab)\b/i;
    if (usSuffixes.test(brandName) && !euIndicator.test(brandName)) return true;

    return false;
  }

  private extractBrandName(activity: RetailerActivityRow): string | null {
    const details = activity.details as Record<string, unknown> | null;
    if (!details) return null;
    const name = details.brandName ?? details.brand ?? details.name;
    return typeof name === 'string' ? name.trim() : null;
  }

  // ---------------------------------------------------------------------------
  // DeepSeek synthesis
  // ---------------------------------------------------------------------------

  private async synthesiseWithDeepSeek(
    countryCode: string,
    insights: RuleInsight[],
  ): Promise<DeepSeekSynthesis | null> {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      logger.debug('[RetailerAgent] DEEPSEEK_API_KEY not set — skipping AI synthesis');
      return null;
    }

    const prompt = buildSynthesisPrompt(countryCode, insights);

    const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        temperature: 0.3,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You are a market intelligence analyst specialising in EU retail and US brand expansion. ' +
              'You interpret structured retailer activity data and produce concise, actionable insights. ' +
              'Always respond with valid JSON matching the requested schema.',
          },
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      throw new Error(`DeepSeek API ${resp.status}: ${await resp.text()}`);
    }

    const json = (await resp.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    const raw = json.choices?.[0]?.message?.content;
    if (!raw) return null;

    return JSON.parse(raw) as DeepSeekSynthesis;
  }

  // ---------------------------------------------------------------------------
  // Persist
  // ---------------------------------------------------------------------------

  private async persist(insights: RuleInsight[]): Promise<void> {
    for (const insight of insights) {
      try {
        await db.insert(retailerInsights).values({
          id: insight.id,
          category: insight.category,
          countryCode: insight.countryCode,
          patternType: insight.patternType,
          retailerCount: insight.retailerCount,
          evidenceIds: insight.evidenceIds,
          confidence: insight.confidence,
          ruleDetails: insight.ruleDetails,
          aiSynthesis: (insight as RuleInsight & { aiSynthesis?: string }).aiSynthesis ?? null,
          detectedAt: new Date(),
        });
      } catch (err) {
        logger.warn(
          { id: insight.id, err },
          '[RetailerAgent] Failed to insert retailer insight',
        );
      }
    }

    if (insights.length > 0) {
      await db.insert(agentOutputs).values({
        agentType: 'retailer_behavior',
        outputData: {
          runAt: new Date().toISOString(),
          insightsDetected: insights.length,
          summary: insights.map(i => ({
            category: i.category,
            countryCode: i.countryCode,
            patternType: i.patternType,
            retailerCount: i.retailerCount,
            confidence: i.confidence,
          })),
        },
        relatedEntityIds: insights.map(i => i.id),
        createdAt: new Date(),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(item);
  }
  return map;
}

function buildSynthesisPrompt(countryCode: string, insights: RuleInsight[]): string {
  const summaries = insights.map(i => ({
    category: i.category,
    patternType: i.patternType,
    retailerCount: i.retailerCount,
    confidence: i.confidence,
    retailers: i.ruleDetails.retailerNames,
    dateRange: i.ruleDetails.dateRange,
    inferredUsBrands: i.ruleDetails.inferredUsBrands,
  }));

  return `
You are analysing retailer activity data for market: ${countryCode}

Detected patterns (${insights.length} total):
${JSON.stringify(summaries, null, 2)}

For each pattern, write a 2–3 sentence market intelligence narrative suitable for a B2B logistics consultant.
Focus on: what the pattern implies for US brand entry opportunity, timing signals, and any cautions.

Respond ONLY with JSON in this exact shape:
{
  "insights": [
    {
      "category": "<category id>",
      "countryCode": "${countryCode}",
      "patternType": "<expansion|rotation|us_brand_entry>",
      "narrative": "<2-3 sentence narrative>"
    }
  ]
}
`.trim();
}
