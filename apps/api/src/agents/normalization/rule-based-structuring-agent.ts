/**
 * Rule-Based Structuring Agent
 *
 * Runs after each crawler completes (event-driven via BullMQ queue: 'normalization').
 * Reads eu_market_signals.raw_data, classifies the record against taxonomy.json,
 * and writes the structured output to agent_outputs.
 *
 * Records with confidence < CONFIDENCE_THRESHOLD are forwarded to the
 * 'normalization-fallback' queue for AI-assisted classification.
 */

import { Queue, Worker, type Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { euMarketSignals, agentOutputs } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import taxonomyData from '../../config/taxonomy.json' with { type: 'json' };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TaxonomyNode {
  id: string;
  name: string;
  level: number;
  keywords?: string[];
  subcategories?: TaxonomyNode[];
}

export interface NormalizationOutput {
  signalId: string;
  categoryId: string;
  categoryPath: string;
  brand: string | null;
  skuType: string | null;
  priceRange: { min: number | null; max: number | null; currency: string } | null;
  demographics: string[];
  confidenceScore: number;
  needsReview: boolean;
  classifiedBy: 'rule-based';
}

interface NormalizationJobData {
  signalId: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Records below this threshold are forwarded to the AI fallback agent. */
const CONFIDENCE_THRESHOLD = 0.55;

/** Records below this threshold are flagged for human review. */
const HUMAN_REVIEW_THRESHOLD = 0.7;

const QUEUE_NAME = 'normalization' as const;
const FALLBACK_QUEUE_NAME = 'normalization-fallback' as const;

/**
 * Brand patterns grouped by top-level taxonomy category.
 * Regex is matched against the full text corpus extracted from raw_data.
 */
const BRAND_PATTERNS: RegExp[] = [
  // Food & Beverage — bars / snacks
  /\b(quest(?:\s+nutrition)?|clif|rx\s*bar|larabar|kind(?:\s+bar)?|thinkThin|built(?:\s+bar)?|oatly|rx\s*bar)\b/i,
  // Food & Beverage — supplements
  /\b(optimum\s+nutrition|muscleTech|myprotein|dymatize|garden\s+of\s+life|bulk\s+powders|prozis|scitec)\b/i,
  // Food & Beverage — beverages
  /\b(celsius|g\s*fuel|reign|monster|red\s+bull|liquid\s+i\.?v\.?|prime(?:\s+hydration)?|olipop|poppi)\b/i,
  // Sports & Fitness — apparel
  /\b(nike|adidas|lululemon|gymshark|under\s+armour|reebok|new\s+balance|alphalete|vuori|nobull)\b/i,
  // Sports & Fitness — wearables
  /\b(whoop|garmin|polar|fitbit|suunto|coros|apple\s+watch)\b/i,
  // Beauty & Personal Care — skincare
  /\b(cetaphil|cerave|neutrogena|la\s+roche.posay|the\s+ordinary|drunk\s+elephant|paula.s\s+choice|tatcha)\b/i,
  // Beauty & Personal Care — hair
  /\b(olaplex|living\s+proof|briogeo|prose|k18|kevin\.murphy|dpHUE)\b/i,
  // Games & Toys — board / card
  /\b(hasbro|mattel|ravensburger|asmod[eé]e|fantasy\s+flight|wizards\s+of\s+the\s+coast|days\s+of\s+wonder|z.man\s+games)\b/i,
  // Games & Toys — collectibles / figures
  /\b(pop\s+mart|tokidoki|funko|good\s+smile|bandai|kotobukiya|mcfarlane|neca)\b/i,
  // Games & Toys — construction
  /\b(lego|mega\s+bloks|k.nex|magnatiles|picasso\s+tiles)\b/i,
  // Pet products
  /\b(hill.s|royal\s+canin|purina|orijen|acana|zignature|open\s+farm)\b/i,
];

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export class RuleBasedStructuringAgent {
  private readonly worker: Worker<NormalizationJobData>;
  private readonly fallbackQueue: Queue;

  /** keyword (lowercase) → category IDs that list it */
  private readonly keywordIndex = new Map<string, string[]>();
  /** category ID → node */
  private readonly nodeIndex = new Map<string, TaxonomyNode>();
  /** child category ID → parent category ID */
  private readonly parentIndex = new Map<string, string>();

  constructor({ redisUrl }: { redisUrl: string }) {
    const connection = { url: redisUrl };

    this.buildTaxonomyIndex(taxonomyData.categories as TaxonomyNode[]);

    this.fallbackQueue = new Queue(FALLBACK_QUEUE_NAME, { connection });

    this.worker = new Worker<NormalizationJobData>(
      QUEUE_NAME,
      this.process.bind(this),
      { connection, concurrency: 5 },
    );

    this.worker.on('completed', (job) => {
      logger.info({ signalId: job.data.signalId }, 'Normalization complete');
    });

    this.worker.on('failed', (job, err) => {
      logger.error({ signalId: job?.data.signalId, error: err.message }, 'Normalization failed');
    });
  }

  // -------------------------------------------------------------------------
  // Taxonomy index construction
  // -------------------------------------------------------------------------

  private buildTaxonomyIndex(nodes: TaxonomyNode[], parentId?: string): void {
    for (const node of nodes) {
      this.nodeIndex.set(node.id, node);

      if (parentId) {
        this.parentIndex.set(node.id, parentId);
      }

      if (node.keywords) {
        for (const kw of node.keywords) {
          const key = kw.toLowerCase().trim();
          const existing = this.keywordIndex.get(key);
          if (existing) {
            existing.push(node.id);
          } else {
            this.keywordIndex.set(key, [node.id]);
          }
        }
      }

      if (node.subcategories?.length) {
        this.buildTaxonomyIndex(node.subcategories, node.id);
      }
    }
  }

  private getCategoryPath(categoryId: string): string {
    const parts: string[] = [];
    let current: string | undefined = categoryId;

    while (current) {
      const node = this.nodeIndex.get(current);
      if (!node) break;
      parts.unshift(node.name);
      current = this.parentIndex.get(current);
    }

    return parts.length > 0 ? parts.join(' > ') : categoryId;
  }

  // -------------------------------------------------------------------------
  // Classification
  // -------------------------------------------------------------------------

  private classifyText(text: string): { categoryId: string; score: number } | null {
    const lower = text.toLowerCase();
    const scores = new Map<string, number>();

    for (const [keyword, categoryIds] of this.keywordIndex) {
      if (lower.includes(keyword)) {
        // Multi-word keywords score proportionally higher than single words
        const weight = keyword.split(/\s+/).length;
        for (const id of categoryIds) {
          scores.set(id, (scores.get(id) ?? 0) + weight);
        }
      }
    }

    if (scores.size === 0) return null;

    // Prefer deeper (more specific) nodes when scores are tied
    const [bestId, bestScore] = [...scores.entries()].sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      const levelA = this.nodeIndex.get(a[0])?.level ?? 0;
      const levelB = this.nodeIndex.get(b[0])?.level ?? 0;
      return levelB - levelA;
    })[0];

    return { categoryId: bestId, score: bestScore };
  }

  private extractBrand(text: string): string | null {
    for (const pattern of BRAND_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        // Return the first capture group if present, else full match
        return (match[1] ?? match[0]).trim();
      }
    }
    return null;
  }

  private extractSkuType(text: string): string | null {
    const patterns = [
      { re: /(\d+(?:\.\d+)?)\s*(?:oz|g|ml|kg|lbs?)\b/i,                          label: 'size' },
      { re: /(\d+)\s*(?:pack|count|ct|pcs?|pieces?)\b/i,                          label: 'quantity' },
      { re: /\b(?:flavou?r|scent|colou?r)\s*[:\-]?\s*([a-z][a-z\s]{1,24})/i,    label: 'variant' },
    ];

    for (const { re, label } of patterns) {
      const m = text.match(re);
      if (m) return `${label}:${m[0].trim()}`;
    }
    return null;
  }

  private extractDemographics(text: string): string[] {
    const lower = text.toLowerCase();
    const groups: Record<string, string[]> = {
      children:    ['kids', 'children', 'toddler', 'baby', 'infant', 'ages 3', 'ages 4', 'ages 5', 'junior'],
      athletes:    ['athlete', 'gym', 'fitness', 'workout', 'sport', 'training', 'performance', 'pre-workout'],
      seniors:     ['senior', 'elderly', 'aging', 'joint support', 'mobility', '50+', '60+'],
      vegetarians: ['vegan', 'vegetarian', 'plant-based', 'plant based'],
      collectors:  ['collector', 'limited edition', 'rare', 'exclusive', 'blind box', 'signed'],
    };

    return Object.entries(groups)
      .filter(([, kws]) => kws.some((kw) => lower.includes(kw)))
      .map(([group]) => group);
  }

  private extractPriceRange(
    rawData: Record<string, unknown>,
  ): { min: number | null; max: number | null; currency: string } | null {
    // Look for a price-like string anywhere in the raw data
    const priceText = this.findStringField(rawData, ['price', 'priceRange', 'price_range', 'cost']);
    if (!priceText) return null;

    const currency = priceText.match(/[€$£]/)?.[0] ?? 'EUR';
    const nums = priceText.match(/\d+(?:\.\d+)?/g)?.map(Number);
    if (!nums?.length) return { min: null, max: null, currency };

    return { min: Math.min(...nums), max: Math.max(...nums), currency };
  }

  /** Recursively extract a string value for the first matching key. */
  private findStringField(obj: Record<string, unknown>, keys: string[]): string | null {
    for (const key of keys) {
      const val = obj[key];
      if (typeof val === 'string' && val.trim()) return val.trim();
    }
    return null;
  }

  /**
   * Recursively flatten all string values from a nested object/array
   * into a single text corpus for classification.
   */
  private flattenToText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map((v) => this.flattenToText(v)).join(' ');
    if (value && typeof value === 'object') {
      return Object.values(value as Record<string, unknown>)
        .map((v) => this.flattenToText(v))
        .join(' ');
    }
    return '';
  }

  // -------------------------------------------------------------------------
  // Confidence scoring
  // -------------------------------------------------------------------------

  private scoreConfidence(opts: {
    keywordScore: number;
    hasBrand: boolean;
    hasSkuType: boolean;
    hasDemographics: boolean;
  }): number {
    let confidence = 0;

    // Keyword score: normalise against a reasonable maximum of 8 weight points
    confidence += Math.min(opts.keywordScore / 8, 0.55);

    if (opts.hasBrand)        confidence += 0.20;
    if (opts.hasSkuType)      confidence += 0.15;
    if (opts.hasDemographics) confidence += 0.10;

    return Math.min(confidence, 1.0);
  }

  // -------------------------------------------------------------------------
  // BullMQ processor
  // -------------------------------------------------------------------------

  private async process(job: Job<NormalizationJobData>): Promise<void> {
    const { signalId } = job.data;

    const [signal] = await db
      .select()
      .from(euMarketSignals)
      .where(eq(euMarketSignals.id, signalId));

    if (!signal) {
      throw new Error(`Signal ${signalId} not found`);
    }

    const rawData = (signal.rawData ?? {}) as Record<string, unknown>;

    // Build text corpus: signal category field + all text in raw_data
    const corpus = [signal.category, this.flattenToText(rawData)]
      .filter(Boolean)
      .join(' ');

    const classified  = this.classifyText(corpus);
    const brand       = this.extractBrand(corpus);
    const skuType     = this.extractSkuType(corpus);
    const demographics = this.extractDemographics(corpus);
    const priceRange  = this.extractPriceRange(rawData);

    const confidence = this.scoreConfidence({
      keywordScore:    classified?.score ?? 0,
      hasBrand:        brand !== null,
      hasSkuType:      skuType !== null,
      hasDemographics: demographics.length > 0,
    });

    const categoryId   = classified?.categoryId ?? 'unclassified';
    const categoryPath = classified ? this.getCategoryPath(categoryId) : 'Unclassified';

    const output: NormalizationOutput = {
      signalId,
      categoryId,
      categoryPath,
      brand,
      skuType,
      priceRange,
      demographics,
      confidenceScore: confidence,
      needsReview:     confidence < HUMAN_REVIEW_THRESHOLD,
      classifiedBy:    'rule-based',
    };

    await db.insert(agentOutputs).values({
      agentType:        'rule-based-structuring',
      outputData:       output as unknown as Record<string, unknown>,
      relatedEntityIds: [signalId],
    });

    if (output.needsReview) {
      logger.warn(
        { signalId, confidenceScore: confidence, categoryId },
        'Record flagged for human review',
      );
    }

    if (confidence < CONFIDENCE_THRESHOLD) {
      await this.fallbackQueue.add('classify', { signalId, ruleBasedResult: output });
      logger.info(
        { signalId, confidenceScore: confidence, categoryId },
        'Low-confidence record forwarded to AI fallback',
      );
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async close(): Promise<void> {
    await this.worker.close();
    await this.fallbackQueue.close();
  }
}
