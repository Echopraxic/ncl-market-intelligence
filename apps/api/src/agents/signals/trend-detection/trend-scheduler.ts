// src/agents/signals/trend-detection/trend-scheduler.ts
import pLimit from 'p-limit';
import { Redis } from 'ioredis';
import { StatisticalTrendDetectionAgent, CompositeTrend } from './statistical-trend-engine.js';
import { TrendValidator, ValidationResult } from './trend-validator.js';
import { DemandSupplyGapAgent } from '../gap-agent.js';
import { RetailerBehaviorAgent } from '../retailer-agent.js';
import { CrossSignalCorrelationAgent } from '../cross-signal-correlation-agent.js';
import { CompositeScoringAgent } from '../composite-scoring-agent.js';
import { BrandFitScoringAgent } from '../brand-fit-scoring-agent.js';
import { InsightGenerationAgent } from '../insight-generation-agent.js';
import { db } from '../../../db/index.js';
import { humanReviewItems, agentOutputs, trends } from '../../../db/schema.js';
import { and, gte, eq } from 'drizzle-orm';

// ── Config ────────────────────────────────────────────────────────────────────

const VALIDATION_CONCURRENCY = 5;   // parallel validation tasks
const LOCK_TTL_SECONDS = 3600;       // Redis lock held for max 1 hour per run
const IDEMPOTENCY_WINDOW_DAYS = 7;   // skip category+country pairs detected within last N days

// Module-level in-memory lock set: used as Redis fallback when Redis is unavailable.
// Only guards against concurrent in-process executions — Redis lock covers distributed scenarios.
const inMemoryLocks = new Set<string>();

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WeeklyDetectionResult {
  detected: number;           // total trends detected by the engine this run
  newThisPeriod: number;      // after idempotency filter
  autoApproved: number;
  manualReview: number;
  rejected: number;
  gapScored: number;
  retailerInsights: number;   // insights written by RetailerBehaviorAgent
  correlationsScored: number; // bundles written by CrossSignalCorrelationAgent
  compositeScored: number;    // corridors scored by CompositeScoringAgent
  brandPairsScored: number;  // brand×corridor pairs scored by BrandFitScoringAgent
  insightsGenerated: number; // total insights written by InsightGenerationAgent
  jobRunId: string;
  skipped?: boolean;          // true if job was already running or all pairs already processed
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

export class TrendDetectionScheduler {
  private engine: StatisticalTrendDetectionAgent;
  private validator: TrendValidator;
  private gapAgent: DemandSupplyGapAgent;
  private retailerAgent: RetailerBehaviorAgent;
  private correlationAgent: CrossSignalCorrelationAgent;
  private compositeScoringAgent: CompositeScoringAgent;
  private brandFitAgent: BrandFitScoringAgent;
  private insightAgent: InsightGenerationAgent;
  private redis: Redis | null = null;

  constructor() {
    this.engine = new StatisticalTrendDetectionAgent();
    this.validator = new TrendValidator();
    this.gapAgent = new DemandSupplyGapAgent();
    this.retailerAgent = new RetailerBehaviorAgent();
    this.correlationAgent = new CrossSignalCorrelationAgent();
    this.compositeScoringAgent = new CompositeScoringAgent();
    this.brandFitAgent = new BrandFitScoringAgent();
    this.insightAgent  = new InsightGenerationAgent();

    if (process.env.REDIS_URL) {
      try {
        this.redis = new Redis(process.env.REDIS_URL, {
          lazyConnect: true,
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
        });
        this.redis.on('error', () => {
          // Redis unavailable — in-memory fallback takes over; log once and silence
          this.redis = null;
        });
      } catch {
        this.redis = null;
      }
    }
  }

  async runWeeklyDetection(): Promise<WeeklyDetectionResult> {
    const jobRunId = crypto.randomUUID();
    const lockKey = `lock:trend-scheduler:weekly`;

    console.log(`[TrendScheduler] Starting weekly detection (jobRunId=${jobRunId})`);

    // ── 1. Distributed lock ───────────────────────────────────────────────────
    // Prevents concurrent executions across processes (Redis) or in-process (in-memory fallback).
    const lockAcquired = await this.acquireLock(lockKey, jobRunId, LOCK_TTL_SECONDS);
    if (!lockAcquired) {
      console.warn('[TrendScheduler] Lock already held — another run is in progress. Skipping.');
      return { detected: 0, newThisPeriod: 0, autoApproved: 0, manualReview: 0, rejected: 0, gapScored: 0, retailerInsights: 0, correlationsScored: 0, compositeScored: 0, brandPairsScored: 0, insightsGenerated: 0, jobRunId, skipped: true };
    }

    try {
      // ── 2. Idempotency guard ────────────────────────────────────────────────
      // Any category+country pair that already has a trend recorded within the last
      // IDEMPOTENCY_WINDOW_DAYS is skipped to prevent duplicate records from back-to-back runs.
      const windowStart = new Date(Date.now() - IDEMPOTENCY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
      const existingRows = await db
        .select({ category: trends.category, countryCode: trends.countryCode })
        .from(trends)
        .where(gte(trends.createdAt, windowStart));

      const existingPairKeys = new Set(existingRows.map(r => `${r.countryCode}|${r.category}`));

      // ── 3. Detection (engine writes nothing — skipPersist: true) ───────────
      const allTrends = await this.engine.detectTrends(undefined, undefined, 365, { skipPersist: true });
      const newTrends = allTrends.filter(t => !existingPairKeys.has(`${t.countryCode}|${t.category}`));

      if (newTrends.length === 0) {
        console.log(`[TrendScheduler] ${allTrends.length} trends detected; all already recorded within ${IDEMPOTENCY_WINDOW_DAYS}d window. Nothing to write.`);
        return { detected: allTrends.length, newThisPeriod: 0, autoApproved: 0, manualReview: 0, rejected: 0, gapScored: 0, retailerInsights: 0, correlationsScored: 0, compositeScored: 0, brandPairsScored: 0, insightsGenerated: 0, jobRunId, skipped: true };
      }

      // ── 4. Parallel validation with concurrency cap ────────────────────────
      // ValidationResult objects are pure data structures — validation is CPU-bound,
      // no I/O. p-limit still guards against an unexpectedly large batch starving the
      // event loop if validation ever becomes async (e.g., AI-assisted checks).
      const limit = pLimit(VALIDATION_CONCURRENCY);
      const validations = await Promise.all(
        newTrends.map(trend =>
          limit(() => ({ trend, validation: this.validator.validate(trend) }))
        )
      );

      // Classify by outcome
      const toPublish: CompositeTrend[] = [];
      const toReview: Array<{ trend: CompositeTrend; validation: ValidationResult }> = [];
      const toReject: Array<{ trend: CompositeTrend; validation: ValidationResult }> = [];

      for (const { trend, validation } of validations) {
        if (validation.status === 'auto_approved') toPublish.push(trend);
        else if (validation.status === 'manual_review') toReview.push({ trend, validation });
        else toReject.push({ trend, validation });
      }

      // ── 5. Single database transaction ─────────────────────────────────────
      // All trend inserts, status updates, review queue entries, and rejection logs are
      // committed atomically. Nothing is visible to other processes until the full
      // validation pass is complete. If any step throws, Drizzle rolls back automatically.
      const autoApprovedIds: string[] = [];

      await db.transaction(async (tx) => {
        // 5a. Insert all new trend records (status = 'detected')
        await tx.insert(trends).values(
          newTrends.map(t => ({
            id: t.id,
            category: t.category,
            countryCode: t.countryCode,
            growthRate: t.growthRate,
            opportunityTier: t.opportunityTier,
            periodStart: t.timePeriod.start,
            periodEnd: t.timePeriod.end,
            confidence: t.confidence,
            signalIds: t.supportingSignalIds,
            detectionMethods: t.detectionMethods.map(m => m.method),
            isAccelerating: t.isAccelerating,
            volatilityIndex: t.volatilityIndex,
            metadata: {
              methodDetails: t.detectionMethods,
              seasonalityStrength: t.seasonalityStrength,
              statisticalSignificance: t.statisticalSignificance,
              jobRunId,
            },
            status: 'detected',
            createdAt: new Date(),
          }))
        );

        // 5b. Immediately publish auto-approved trends within the same transaction
        const breakthroughAlerts: typeof humanReviewItems.$inferInsert[] = [];
        for (const trend of toPublish) {
          await tx
            .update(trends)
            .set({ status: 'published', publishedAt: new Date(), publicationMethod: 'auto' })
            .where(eq(trends.id, trend.id));
          autoApprovedIds.push(trend.id);

          // C3: Real-time alert for breakthrough-tier trends — high-priority internal flag
          if (trend.opportunityTier === 'breakthrough') {
            breakthroughAlerts.push({
              type: 'trend_validation',
              priority: 10,
              data: {
                trendId: trend.id,
                category: trend.category,
                countryCode: trend.countryCode,
                growthRate: trend.growthRate,
                confidence: trend.confidence,
                tier: 'breakthrough',
                alertType: 'breakthrough_detected',
                jobRunId,
              } as any,
              reviewPrompt: `BREAKTHROUGH ALERT: ${trend.category} × ${trend.countryCode} is growing at ${(trend.growthRate * 100).toFixed(1)}% with ${(trend.confidence * 100).toFixed(0)}% confidence. First-mover window detected — review and approve outreach pipeline.`,
              status: 'pending',
            });
          }
        }

        if (breakthroughAlerts.length > 0) {
          await tx.insert(humanReviewItems).values(breakthroughAlerts);
          console.log(`[TrendScheduler] ${breakthroughAlerts.length} breakthrough alert(s) queued for human review`);
        }

        // 5c. Queue manual-review items (batch insert)
        if (toReview.length > 0) {
          await tx.insert(humanReviewItems).values(
            toReview.map(({ trend, validation }) => ({
              type: 'trend_validation',
              priority: trend.confidence > 0.8 ? 7 : 5,
              data: trend as any,
              validationResult: validation as any,
              reviewPrompt: this.validator.generateReviewPrompt(validation),
              status: 'pending',
            }))
          );
        }

        // 5d. Log rejections (batch insert)
        if (toReject.length > 0) {
          await tx.insert(agentOutputs).values(
            toReject.map(({ trend, validation }) => ({
              agentType: 'trend_detection_rejection',
              outputData: {
                trendId: trend.id,
                category: trend.category,
                countryCode: trend.countryCode,
                rejectionReasons: validation.riskFactors,
                reasons: validation.reasons,
                jobRunId,
              } as any,
            }))
          );
        }
      }); // ← transaction committed here; rollback if any step above threw

      // ── 6. Gap scoring — runs after commit, non-fatal ──────────────────────
      // Excluded from the transaction so a gap-agent failure doesn't roll back
      // the trend records. The gap agent's own DB writes are idempotent.
      let gapScored = 0;
      if (autoApprovedIds.length > 0) {
        try {
          const gapResult = await this.gapAgent.run(autoApprovedIds);
          gapScored = gapResult.scored;
          console.log(`[TrendScheduler] GapAgent scored ${gapScored} pairs`);
        } catch (err) {
          console.error(`[TrendScheduler] GapAgent failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // ── 7. Notify downstream systems ───────────────────────────────────────
      const { retailerInsights, correlationsScored, compositeScored, brandPairsScored, insightsGenerated } =
        await this.notifyDownstreamSystems(toPublish, jobRunId);

      const stats: WeeklyDetectionResult = {
        detected: allTrends.length,
        newThisPeriod: newTrends.length,
        autoApproved: toPublish.length,
        manualReview: toReview.length,
        rejected: toReject.length,
        gapScored,
        retailerInsights,
        correlationsScored,
        compositeScored,
        brandPairsScored,
        insightsGenerated,
        jobRunId,
      };

      await this.reportStats(stats);
      return stats;

    } finally {
      // Always release the lock even if the run throws
      await this.releaseLock(lockKey, jobRunId);
    }
  }

  // ── Lock helpers ───────────────────────────────────────────────────────────

  private async acquireLock(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    if (!this.redis) {
      if (inMemoryLocks.has(key)) return false;
      inMemoryLocks.add(key);
      setTimeout(() => inMemoryLocks.delete(key), ttlSeconds * 1000);
      return true;
    }
    try {
      const result = await this.redis.set(key, value, 'EX', ttlSeconds, 'NX');
      return result === 'OK';
    } catch {
      // Redis error — fall back to in-memory lock
      if (inMemoryLocks.has(key)) return false;
      inMemoryLocks.add(key);
      setTimeout(() => inMemoryLocks.delete(key), ttlSeconds * 1000);
      return true;
    }
  }

  private async releaseLock(key: string, value: string): Promise<void> {
    inMemoryLocks.delete(key);
    if (!this.redis) return;
    try {
      // Only delete the key if the stored value matches our jobRunId.
      // Prevents a slow job from deleting a lock acquired by a later run.
      const current = await this.redis.get(key);
      if (current === value) {
        await this.redis.del(key);
      }
    } catch {
      // Redis error on release — key will expire via TTL
    }
  }

  // ── Downstream notification ────────────────────────────────────────────────
  // Runs after the transaction commits and gap scoring completes.
  // Each downstream agent is non-fatal: a failure logs and returns 0 rather than
  // aborting the run. Retailer agent runs first so CrossSignalCorrelation has
  // fresh retailer_insights rows to correlate against.

  private async notifyDownstreamSystems(
    publishedTrends: CompositeTrend[],
    jobRunId: string,
  ): Promise<{ retailerInsights: number; correlationsScored: number; compositeScored: number; brandPairsScored: number; insightsGenerated: number }> {
    if (publishedTrends.length === 0) {
      return { retailerInsights: 0, correlationsScored: 0, compositeScored: 0, brandPairsScored: 0, insightsGenerated: 0 };
    }

    console.log(
      `[TrendScheduler] ${publishedTrends.length} trend(s) published (jobRunId=${jobRunId}) — ` +
      `triggering RetailerBehaviorAgent → CrossSignalCorrelationAgent → CompositeScoringAgent → BrandFitScoringAgent → InsightGenerationAgent`
    );

    // ── Step A: RetailerBehaviorAgent ──────────────────────────────────────
    // Refreshes retailer_insights so downstream agents see up-to-date
    // expansion/rotation/us_brand_entry patterns for the active corridors.
    let retailerInsights = 0;
    try {
      const retailerResult = await this.retailerAgent.run();
      retailerInsights = retailerResult.detected;
      console.log(`[TrendScheduler] RetailerAgent wrote ${retailerInsights} insights`);
    } catch (err) {
      console.error(
        `[TrendScheduler] RetailerAgent failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // ── Step B: CrossSignalCorrelationAgent ────────────────────────────────
    // Runs after retailer so correlation bundles reflect the freshest insights.
    let correlationsScored = 0;
    try {
      const correlationResult = await this.correlationAgent.run();
      correlationsScored = correlationResult.bundlesProduced;
      console.log(`[TrendScheduler] CorrelationAgent wrote ${correlationsScored} bundles`);
    } catch (err) {
      console.error(
        `[TrendScheduler] CorrelationAgent failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // ── Step C: CompositeScoringAgent ──────────────────────────────────────
    // Runs last — depends on gap scores (step 6), retailer insights (A), and
    // correlation bundles (B) all being fresh. Upserts opportunity_scores rows.
    let compositeScored = 0;
    try {
      const compositeResult = await this.compositeScoringAgent.run();
      compositeScored = compositeResult.corridorsScored;
      console.log(
        `[TrendScheduler] CompositeScoringAgent scored ${compositeScored} corridors ` +
        `(≥80: ${compositeResult.above80}, ≥70: ${compositeResult.above70})`
      );
    } catch (err) {
      console.error(
        `[TrendScheduler] CompositeScoringAgent failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // ── Step D: BrandFitScoringAgent ───────────────────────────────────────
    // Runs after CompositeScoringAgent so corridor scores (brandId=null) are
    // fresh. Writes one opportunity_scores row per (brand, category, country).
    let brandPairsScored = 0;
    try {
      const brandFitResult = await this.brandFitAgent.run();
      brandPairsScored = brandFitResult.brandCorridorPairsWritten;
      console.log(
        `[TrendScheduler] BrandFitAgent scored ${brandFitResult.brandsWithMatches}/${brandFitResult.brandsEvaluated} brands ` +
        `across ${brandPairsScored} corridor pairs (≥80: ${brandFitResult.above80}, ≥70: ${brandFitResult.above70})`,
      );
    } catch (err) {
      console.error(
        `[TrendScheduler] BrandFitAgent failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // ── Step E: InsightGenerationAgent ────────────────────────────────────
    // Runs last — needs fresh scores from CompositeScoringAgent (C) and
    // BrandFitScoringAgent (D). Writes draft insights to the insights table.
    let insightsGenerated = 0;
    try {
      const insightResult = await this.insightAgent.run();
      insightsGenerated = insightResult.total;
      console.log(
        `[TrendScheduler] InsightAgent wrote ${insightsGenerated} insights ` +
        `(alerts: ${insightResult.opportunityAlerts}, briefs: ${insightResult.marketBriefs}, ` +
        `playbooks: ${insightResult.tradeShowPlaybooks}, digest: ${insightResult.weeklyReport})`,
      );
    } catch (err) {
      console.error(
        `[TrendScheduler] InsightAgent failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // TODO (Phase 4 — when BullMQ is available on Redis 5+):
    //   outreachQueue.add('rank-outreach', { jobRunId })

    return { retailerInsights, correlationsScored, compositeScored, brandPairsScored, insightsGenerated };
  }

  // ── Reporting ──────────────────────────────────────────────────────────────

  private async reportStats(stats: WeeklyDetectionResult): Promise<void> {
    const pct = (n: number) => stats.newThisPeriod > 0
      ? ((n / stats.newThisPeriod) * 100).toFixed(1) : '0.0';

    console.log(`
[TrendScheduler] Weekly Run Complete
=====================================
Job Run ID: ${stats.jobRunId}
Total Detected (engine): ${stats.detected}
New This Period: ${stats.newThisPeriod}

Validation Outcomes (of new):
  Auto-Approved: ${stats.autoApproved} (${pct(stats.autoApproved)}%)
  Manual Review: ${stats.manualReview} (${pct(stats.manualReview)}%)
  Rejected:      ${stats.rejected} (${pct(stats.rejected)}%)

Downstream:
  Gap Pairs Scored:        ${stats.gapScored}
  Retailer Insights:       ${stats.retailerInsights}
  Correlation Bundles:     ${stats.correlationsScored}
  Composite Corridors:     ${stats.compositeScored}
  Brand×Corridor Pairs:    ${stats.brandPairsScored}
  Insights Written:        ${stats.insightsGenerated}

Quality Gates:
  Auto-approval: confidence > 90%, 0 risk factors, p < 0.05
  Manual review: borderline confidence or 1–2 risk factors
  Rejection:     >2 risk factors or confidence < 70%
    `.trim());
  }
}
