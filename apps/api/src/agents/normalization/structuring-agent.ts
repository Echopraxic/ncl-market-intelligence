/**
 * AI Structuring Agent (DeepSeek fallback)
 *
 * Handles records that the rule-based agent could not classify with sufficient
 * confidence (queue: 'normalization-fallback').  Uses the DeepSeek chat API
 * (OpenAI-compatible) to perform taxonomy classification as a last resort.
 *
 * Output is written to agent_outputs, tagged 'ai-structuring', so both
 * rule-based and AI results are independently queryable.
 */

import { Worker, type Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { euMarketSignals, agentOutputs } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import taxonomyData from '../../config/taxonomy.json' with { type: 'json' };
import type { NormalizationOutput } from './rule-based-structuring-agent.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TaxonomyNode {
  id: string;
  name: string;
  level: number;
  subcategories?: TaxonomyNode[];
}

interface FallbackJobData {
  signalId: string;
  ruleBasedResult: NormalizationOutput;
}

interface DeepSeekClassification {
  category_id: string;
  category_path: string;
  brand: string | null;
  sku_type: string | null;
  demographics: string[];
  confidence_score: number;
  needs_review: boolean;
  reasoning: string;
}

interface AiNormalizationOutput extends DeepSeekClassification {
  signalId: string;
  classifiedBy: 'ai-deepseek';
  ruleBasedFallback: NormalizationOutput;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';
const DEEPSEEK_MODEL   = 'deepseek-chat';
const QUEUE_NAME       = 'normalization-fallback' as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a compact taxonomy listing for the prompt.
 * Indented tree format keeps token count low while preserving hierarchy.
 */
function buildTaxonomyListing(nodes: TaxonomyNode[], depth = 0): string {
  return nodes
    .flatMap((n) => {
      const indent = '  '.repeat(depth);
      const line   = `${indent}- ${n.id}: ${n.name}`;
      return n.subcategories?.length
        ? [line, buildTaxonomyListing(n.subcategories, depth + 1)]
        : [line];
    })
    .join('\n');
}

const TAXONOMY_LISTING = buildTaxonomyListing(taxonomyData.categories as TaxonomyNode[]);

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export class DataStructuringAgent {
  private readonly worker: Worker<FallbackJobData>;

  constructor({ redisUrl }: { redisUrl: string }) {
    const connection = { url: redisUrl };

    this.worker = new Worker<FallbackJobData>(
      QUEUE_NAME,
      this.process.bind(this),
      {
        connection,
        // Keep concurrency low — each call hits an external API
        concurrency: 3,
      },
    );

    this.worker.on('completed', (job) => {
      logger.info({ signalId: job.data.signalId }, 'AI structuring complete');
    });

    this.worker.on('failed', (job, err) => {
      logger.error(
        { signalId: job?.data.signalId, error: err.message },
        'AI structuring failed',
      );
    });
  }

  // -------------------------------------------------------------------------
  // DeepSeek classification
  // -------------------------------------------------------------------------

  private buildPrompt(
    signal: typeof euMarketSignals.$inferSelect,
    ruleBasedResult: NormalizationOutput,
  ): string {
    const rawData = signal.rawData ?? {};

    return `You are a product taxonomy classification expert for an EU market intelligence system.

A rule-based classifier could not confidently classify this market signal.

Signal details:
- Source: ${signal.source}
- Country: ${signal.countryCode}
- Category (raw): ${signal.category}
- Signal type: ${signal.signalType}
- Signal value: ${signal.signalValue}
- Raw data: ${JSON.stringify(rawData, null, 2)}

Rule-based best guess:
- Category: ${ruleBasedResult.categoryId}
- Brand: ${ruleBasedResult.brand ?? 'not detected'}
- Confidence: ${ruleBasedResult.confidenceScore.toFixed(2)}

Available taxonomy (id: Name):
${TAXONOMY_LISTING}

Respond with a JSON object only — no markdown, no explanation outside the JSON:
{
  "category_id": "<most specific matching taxonomy ID from the list above, or 'unclassified'>",
  "category_path": "<human-readable path, e.g. Food & Beverage > Snacks > Protein Bars>",
  "brand": "<extracted brand name, or null>",
  "sku_type": "<size/variant/quantity descriptor, or null>",
  "demographics": ["<target group>"],
  "confidence_score": <0.0–1.0>,
  "needs_review": <true if confidence_score < 0.7, else false>,
  "reasoning": "<one concise sentence explaining the classification>"
}`;
  }

  private async callDeepSeek(prompt: string): Promise<DeepSeekClassification> {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new Error('DEEPSEEK_API_KEY environment variable is not set');
    }

    const response = await fetch(DEEPSEEK_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model:           DEEPSEEK_MODEL,
        messages:        [{ role: 'user', content: prompt }],
        temperature:     0.15,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '(no body)');
      throw new Error(`DeepSeek API error ${response.status}: ${body}`);
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    const content = data.choices[0]?.message?.content;
    if (!content) throw new Error('DeepSeek returned empty content');

    return JSON.parse(content) as DeepSeekClassification;
  }

  // -------------------------------------------------------------------------
  // BullMQ processor
  // -------------------------------------------------------------------------

  private async process(job: Job<FallbackJobData>): Promise<void> {
    const { signalId, ruleBasedResult } = job.data;

    const [signal] = await db
      .select()
      .from(euMarketSignals)
      .where(eq(euMarketSignals.id, signalId));

    if (!signal) {
      throw new Error(`Signal ${signalId} not found`);
    }

    const prompt         = this.buildPrompt(signal, ruleBasedResult);
    const classification = await this.callDeepSeek(prompt);

    const output: AiNormalizationOutput = {
      signalId,
      classifiedBy:    'ai-deepseek',
      ruleBasedFallback: ruleBasedResult,
      ...classification,
    };

    await db.insert(agentOutputs).values({
      agentType:        'ai-structuring',
      outputData:       output as unknown as Record<string, unknown>,
      relatedEntityIds: [signalId],
    });

    if (classification.needs_review) {
      logger.warn(
        { signalId, confidenceScore: classification.confidence_score, categoryId: classification.category_id },
        'AI-classified record flagged for human review',
      );
    }

    logger.info(
      {
        signalId,
        categoryId:     classification.category_id,
        confidenceScore: classification.confidence_score,
        needsReview:    classification.needs_review,
        reasoning:      classification.reasoning,
      },
      'AI classification stored',
    );
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async close(): Promise<void> {
    await this.worker.close();
  }
}
