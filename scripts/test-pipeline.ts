/**
 * Direct pipeline test — no BullMQ / Redis required.
 *
 * 1. Runs TradeShowCrawler directly (seeds 5 shows into DB)
 * 2. Seeds 3 synthetic eu_market_signals for normalization testing
 * 3. Runs rule-based normalization logic inline on each signal
 * 4. Prints a summary report
 *
 * Usage:
 *   cd apps/api
 *   DATABASE_URL=postgresql://ncl_user:ncl_password@localhost:5432/ncl_mie \
 *   npx tsx ../../scripts/test-pipeline.ts
 */

import { db } from '../apps/api/src/db/index.js';
import { euMarketSignals, agentOutputs, tradeShows } from '../apps/api/src/db/schema.js';
import { TradeShowCrawler } from '../apps/api/src/agents/crawlers/trade-show-crawler.js';
import { RuleBasedStructuringAgent } from '../apps/api/src/agents/normalization/rule-based-structuring-agent.js';
import { sql } from 'drizzle-orm';

// ─── ANSI colours ────────────────────────────────────────────────────────────
const green  = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red    = (s: string) => `\x1b[31m${s}\x1b[0m`;
const bold   = (s: string) => `\x1b[1m${s}\x1b[0m`;

function hr(char = '─', len = 60) { return char.repeat(len); }

// ─── 1. Trade show crawler ────────────────────────────────────────────────────

async function runTradeShowCrawler(): Promise<void> {
  console.log(`\n${bold('━━━ Phase 1: Trade Show Crawler ━━━')}`);
  console.log('Seeding trade show metadata (no Playwright for Canton Fair; Playwright for others)...\n');

  const crawler = new TradeShowCrawler({ rateLimitMs: 500, maxRetries: 1 });

  try {
    const result = await crawler.runWithTracking();
    console.log(green(`  ✓ Completed: ${result.recordsFound} exhibitor records found`));
    if (result.errors.length > 0) {
      console.log(yellow(`  ⚠  ${result.errors.length} non-fatal errors:`));
      result.errors.forEach((e) => console.log(yellow(`    • ${e}`)));
    }
  } catch (err) {
    console.log(red(`  ✗ Crawler failed: ${(err as Error).message}`));
  }

  // Show what was seeded
  const shows = await db.select({ name: tradeShows.name, countryCode: tradeShows.countryCode, startDate: tradeShows.startDate })
    .from(tradeShows);
  console.log(`\n  DB: ${shows.length} trade shows seeded`);
  for (const show of shows) {
    const date = show.startDate ? show.startDate.toISOString().split('T')[0] : '?';
    console.log(`    • [${show.countryCode}] ${show.name} — ${date}`);
  }
}

// ─── 2. Seed synthetic market signals ────────────────────────────────────────

async function seedTestSignals(): Promise<string[]> {
  console.log(`\n${bold('━━━ Phase 2: Seeding Test Market Signals ━━━')}`);

  const testSignals = [
    {
      source: 'google_trends' as const,
      countryCode: 'DE',
      category: 'Wellness & Supplements',
      signalType: 'trend' as const,
      signalValue: 72.5,
      rawData: {
        keywords: ['collagen supplements', 'gut health', 'adaptogen'],
        timeframe: 'today 12-m',
        interestOverTime: [
          { date: '2026-01-01', keyword: 'collagen supplements', value: 68, is_partial: false },
          { date: '2026-02-01', keyword: 'collagen supplements', value: 75, is_partial: false },
          { date: '2026-03-01', keyword: 'gut health', value: 80, is_partial: false },
        ],
        relatedQueries: {},
      },
    },
    {
      source: 'amazon_eu' as const,
      countryCode: 'FR',
      category: 'Toys & Games (bestsellers)',
      signalType: 'demand' as const,
      signalValue: 48,
      rawData: {
        pageType: 'bestsellers',
        currency: 'EUR',
        domain: 'amazon.fr',
        categoryPath: 'Toys & Games',
        topProducts: [
          { asin: 'B08N5LNQCV', title: 'LEGO Technic 42183 Set', rank: 1, reviewCount: 1250, rating: 4.7, price: '€89.99', velocityScore: 85 },
          { asin: 'B09KZ9XWDQ', title: 'Ravensburger 1000pc Puzzle', rank: 2, reviewCount: 890, rating: 4.5, price: '€24.99', velocityScore: 72 },
          { asin: 'B07PBPVKYX', title: 'Hasbro Monopoly Classic', rank: 3, reviewCount: 3200, rating: 4.3, price: '€29.99', velocityScore: 61 },
        ],
      },
    },
    {
      source: 'amazon_eu' as const,
      countryCode: 'DE',
      category: 'Health & Personal Care (bestsellers)',
      signalType: 'demand' as const,
      signalValue: 35,
      rawData: {
        pageType: 'bestsellers',
        currency: 'EUR',
        domain: 'amazon.de',
        categoryPath: 'Health & Personal Care',
        topProducts: [
          { asin: 'B00PUH0JLS', title: 'CeraVe Moisturizing Cream 340g', rank: 1, reviewCount: 28500, rating: 4.8, price: '€18.49', velocityScore: 92 },
          { asin: 'B07MTYX2BN', title: 'Optimum Nutrition Gold Whey 2.27kg', rank: 2, reviewCount: 15200, rating: 4.6, price: '€64.99', velocityScore: 88 },
          { asin: 'B0BQ1V8N3L', title: 'Garden of Life Collagen Peptides', rank: 3, reviewCount: 4100, rating: 4.4, price: '€34.99', velocityScore: 75 },
        ],
      },
    },
  ];

  const insertedIds: string[] = [];

  for (const signal of testSignals) {
    const [row] = await db.insert(euMarketSignals).values(signal).returning({ id: euMarketSignals.id });
    insertedIds.push(row.id);
    console.log(green(`  ✓ Seeded signal: [${signal.countryCode}] ${signal.category} (source: ${signal.source})`));
  }

  console.log(`\n  Total: ${insertedIds.length} test signals inserted`);
  return insertedIds;
}

// ─── 3. Run normalization inline ──────────────────────────────────────────────

async function runNormalization(signalIds: string[]): Promise<void> {
  console.log(`\n${bold('━━━ Phase 3: Rule-Based Normalization ━━━')}`);
  console.log('Running normalization inline (bypassing BullMQ)...\n');

  // We instantiate the agent but use its internals directly (no BullMQ needed).
  // We do this by reading signals from DB and calling the agent's DB insert logic.
  // Since the agent is class-based with private methods, we run normalizeSignal here.

  const taxonomyData = (await import('../apps/api/src/config/taxonomy.json', { with: { type: 'json' } })).default;

  interface TaxonomyNode {
    id: string;
    name: string;
    level: number;
    keywords?: string[];
    subcategories?: TaxonomyNode[];
  }

  // Rebuild the keyword index
  const keywordIndex = new Map<string, string[]>();
  const nodeIndex    = new Map<string, TaxonomyNode>();
  const parentIndex  = new Map<string, string>();

  function buildIndex(nodes: TaxonomyNode[], parentId?: string): void {
    for (const node of nodes) {
      nodeIndex.set(node.id, node);
      if (parentId) parentIndex.set(node.id, parentId);
      if (node.keywords) {
        for (const kw of node.keywords) {
          const key = kw.toLowerCase().trim();
          const ex = keywordIndex.get(key);
          ex ? ex.push(node.id) : keywordIndex.set(key, [node.id]);
        }
      }
      if (node.subcategories?.length) buildIndex(node.subcategories, node.id);
    }
  }

  buildIndex((taxonomyData as { categories: TaxonomyNode[] }).categories);

  function getCategoryPath(id: string): string {
    const parts: string[] = [];
    let cur: string | undefined = id;
    while (cur) {
      const n = nodeIndex.get(cur);
      if (!n) break;
      parts.unshift(n.name);
      cur = parentIndex.get(cur);
    }
    return parts.length > 0 ? parts.join(' > ') : id;
  }

  function classifyText(text: string): { categoryId: string; score: number } | null {
    const lower  = text.toLowerCase();
    const scores = new Map<string, number>();
    for (const [kw, ids] of keywordIndex) {
      if (lower.includes(kw)) {
        const weight = kw.split(/\s+/).length;
        for (const id of ids) scores.set(id, (scores.get(id) ?? 0) + weight);
      }
    }
    if (scores.size === 0) return null;
    const [bestId, bestScore] = [...scores.entries()].sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return (nodeIndex.get(b[0])?.level ?? 0) - (nodeIndex.get(a[0])?.level ?? 0);
    })[0];
    return { categoryId: bestId, score: bestScore };
  }

  function flattenToText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(flattenToText).join(' ');
    if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).map(flattenToText).join(' ');
    return '';
  }

  const BRAND_PATTERNS = [
    /\b(quest(?:\s+nutrition)?|clif|rxbar|larabar|kind(?:\s+bar)?|oatly)\b/i,
    /\b(optimum\s+nutrition|myprotein|dymatize|garden\s+of\s+life|bulk\s+powders)\b/i,
    /\b(cerave|cetaphil|neutrogena|la\s+roche.posay|the\s+ordinary|drunk\s+elephant)\b/i,
    /\b(hasbro|mattel|ravensburger|asmodeé|lego|mega\s+bloks)\b/i,
    /\b(hill.s|royal\s+canin|purina|orijen)\b/i,
  ];

  function extractBrand(text: string): string | null {
    for (const re of BRAND_PATTERNS) {
      const m = text.match(re);
      if (m) return (m[1] ?? m[0]).trim();
    }
    return null;
  }

  function scoreConfidence(opts: { kwScore: number; hasBrand: boolean; hasSkuType: boolean; hasDemographics: boolean }): number {
    let c = Math.min(opts.kwScore / 8, 0.55);
    if (opts.hasBrand) c += 0.20;
    if (opts.hasSkuType) c += 0.15;
    if (opts.hasDemographics) c += 0.10;
    return Math.min(c, 1.0);
  }

  const HUMAN_REVIEW_THRESHOLD = 0.7;

  // ── Process each signal ──
  const { eq } = await import('drizzle-orm');

  for (const signalId of signalIds) {
    const [signal] = await db.select().from(euMarketSignals).where(eq(euMarketSignals.id, signalId));
    if (!signal) { console.log(red(`  ✗ Signal ${signalId} not found`)); continue; }

    const rawData  = (signal.rawData ?? {}) as Record<string, unknown>;
    const corpus   = [signal.category, flattenToText(rawData)].filter(Boolean).join(' ');

    const classified   = classifyText(corpus);
    const brand        = extractBrand(corpus);
    const hasDemographics = /vegan|vegetarian|plant.based|athletes?|gym|senior|collector/i.test(corpus);

    const confidence = scoreConfidence({
      kwScore:      classified?.score ?? 0,
      hasBrand:     brand !== null,
      hasSkuType:   false,
      hasDemographics,
    });

    const categoryId   = classified?.categoryId ?? 'unclassified';
    const categoryPath = classified ? getCategoryPath(categoryId) : 'Unclassified';
    const needsReview  = confidence < HUMAN_REVIEW_THRESHOLD;

    const output = {
      signalId,
      categoryId,
      categoryPath,
      brand,
      skuType: null,
      priceRange: null,
      demographics: hasDemographics ? ['detected'] : [],
      confidenceScore: confidence,
      needsReview,
      classifiedBy: 'rule-based' as const,
    };

    await db.insert(agentOutputs).values({
      agentType:        'rule-based-structuring',
      outputData:       output as unknown as Record<string, unknown>,
      relatedEntityIds: [signalId],
    });

    const status = needsReview ? yellow('⚠  needs_review') : green('✓  confident');
    console.log(`  [${signal.countryCode}] ${signal.category}`);
    console.log(`    → category : ${bold(categoryPath)}`);
    console.log(`    → brand    : ${brand ?? '(none detected)'}`);
    console.log(`    → score    : ${confidence.toFixed(2)}  ${status}`);
    console.log();
  }
}

// ─── 4. Summary ──────────────────────────────────────────────────────────────

async function printSummary(): Promise<void> {
  console.log(`\n${bold('━━━ Summary ━━━')}`);

  const [signalCount] = await db.select({ count: sql<number>`count(*)::int` }).from(euMarketSignals);
  const [outputCount] = await db.select({ count: sql<number>`count(*)::int` }).from(agentOutputs);
  const [showCount]   = await db.select({ count: sql<number>`count(*)::int` }).from(tradeShows);

  console.log(`  eu_market_signals  : ${signalCount.count}`);
  console.log(`  agent_outputs      : ${outputCount.count}`);
  console.log(`  trade_shows        : ${showCount.count}`);
  console.log();
  console.log(green('  Pipeline test complete.'));
  console.log('  Next: start Redis 5+ to enable BullMQ scheduling and real crawlers.');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(bold(`\n${'═'.repeat(60)}`));
  console.log(bold('  NCL Market Intelligence — Direct Pipeline Test'));
  console.log(bold(`${'═'.repeat(60)}`));

  try {
    // Probe DB
    await db.execute(sql`SELECT 1`);
    console.log(green('\n  ✓ Database connected'));
  } catch (err) {
    console.error(red(`\n  ✗ Database connection failed: ${(err as Error).message}`));
    process.exit(1);
  }

  await runTradeShowCrawler();
  const signalIds = await seedTestSignals();
  await runNormalization(signalIds);
  await printSummary();

  process.exit(0);
}

main().catch((err) => {
  console.error(red(`\nFatal: ${(err as Error).message}`));
  process.exit(1);
});
