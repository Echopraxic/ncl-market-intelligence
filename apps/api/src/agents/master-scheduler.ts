// Master pipeline orchestrator — runs the full NCL intelligence pipeline in order.
// Intended for weekly cron execution but can also be triggered manually via the API.
//
// Order:
//   1. Trade flow intelligence + analytics (foundational data)
//   2. NI routing signals
//   3. Crawlers: Shopify, Google Trends, Amazon EU, Trade Shows (direct execution — Redis-gated BullMQ not used)
//   4. Trend detection scheduler (internally runs: gap → retailer → correlation → composite → brand-fit → insights)
//   5. Lead-gen chain: discovery → scoring → pitch angles → CRM export
//   6. Trigger rules engine (fires actions on high-scoring corridors)

import { logger } from '../lib/logger.js';

export type MasterSchedulerResult = {
  runId: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  steps: Record<string, StepOutcome>;
  totalErrors: number;
};

type StepOutcome = {
  status: 'success' | 'failed' | 'skipped';
  durationMs: number;
  detail?: unknown;
  error?: string;
};

export class MasterSchedulerAgent {
  async run(): Promise<MasterSchedulerResult> {
    const runId = crypto.randomUUID();
    const startedAt = new Date();
    const steps: Record<string, StepOutcome> = {};
    let totalErrors = 0;

    logger.info({ runId }, '[MasterScheduler] Weekly pipeline starting');

    // ── Step 1a: Trade flow intelligence ──────────────────────────────────────
    await this.runStep(steps, 'trade-flow', async () => {
      const { TradeFlowIntelligenceAgent } = await import('./signals/trade-flow-agent.js');
      const agent = new TradeFlowIntelligenceAgent();
      return agent.run(false);
    });

    // ── Step 1b: Trade flow analytics ─────────────────────────────────────────
    await this.runStep(steps, 'trade-analytics', async () => {
      const { TradeFlowAnalyticsEngine } = await import('./signals/trade-flow-analytics.js');
      const engine = new TradeFlowAnalyticsEngine();
      return engine.run(false);
    });

    // ── Step 2: NI routing signals ────────────────────────────────────────────
    await this.runStep(steps, 'ni-routing', async () => {
      const { NIRoutingAgent } = await import('./signals/ni-routing-agent.js');
      const agent = new NIRoutingAgent();
      return agent.run();
    });

    // ── Step 3: Crawlers (direct execution) ────────────────────────────────────
    // Runs each crawler sequentially to avoid hammering target sites.
    await this.runStep(steps, 'crawl-shopify', async () => {
      const { ShopifyBrandCrawler } = await import('./crawlers/shopify-brand-crawler.js');
      const c = new ShopifyBrandCrawler();
      return c.runWithTracking();
    });

    await this.runStep(steps, 'crawl-google-trends', async () => {
      const { GoogleTrendsCrawler } = await import('./crawlers/google-trends-crawler.js');
      const c = new GoogleTrendsCrawler();
      return c.runWithTracking();
    });

    await this.runStep(steps, 'crawl-amazon-eu', async () => {
      const { AmazonEUCrawler } = await import('./crawlers/amazon-eu-crawler.js');
      const c = new AmazonEUCrawler();
      return c.runWithTracking();
    });

    await this.runStep(steps, 'crawl-trade-shows', async () => {
      const { TradeShowCrawler } = await import('./crawlers/trade-show-crawler.js');
      const c = new TradeShowCrawler();
      return c.runWithTracking();
    });

    await this.runStep(steps, 'crawl-cpg-directory', async () => {
      const { CPGDirectoryCrawler } = await import('./crawlers/cpg-directory-crawler.js');
      const c = new CPGDirectoryCrawler();
      return c.runWithTracking();
    });

    await this.runStep(steps, 'crawl-faire', async () => {
      const { FaireCrawler } = await import('./crawlers/faire-crawler.js');
      const c = new FaireCrawler();
      return c.runWithTracking();
    });

    await this.runStep(steps, 'crawl-thingtesting', async () => {
      const { ThingTestingCrawler } = await import('./crawlers/thingtesting-crawler.js');
      const c = new ThingTestingCrawler();
      return c.runWithTracking();
    });

    await this.runStep(steps, 'crawl-bulletin', async () => {
      const { BulletinCrawler } = await import('./crawlers/bulletin-crawler.js');
      const c = new BulletinCrawler();
      return c.runWithTracking();
    });

    // ── Step 4: Trend detection (runs gap → retailer → correlation → composite → brand-fit → insights internally) ──
    await this.runStep(steps, 'trend-scheduler', async () => {
      const { TrendDetectionScheduler } = await import('./signals/trend-detection/trend-scheduler.js');
      const scheduler = new TrendDetectionScheduler();
      return scheduler.runWeeklyDetection();
    });

    // ── Step 5: Lead-gen chain ────────────────────────────────────────────────
    await this.runStep(steps, 'lead-discovery', async () => {
      const { LeadDiscoveryAgent } = await import('./lead-gen/lead-discovery-agent.js');
      return new LeadDiscoveryAgent().run();
    });

    await this.runStep(steps, 'lead-scoring', async () => {
      const { LeadScoringAgent } = await import('./lead-gen/lead-scoring-agent.js');
      return new LeadScoringAgent().run();
    });

    await this.runStep(steps, 'pitch-angles', async () => {
      const { PitchAngleAgent } = await import('./lead-gen/pitch-angle-agent.js');
      return new PitchAngleAgent().run();
    });

    await this.runStep(steps, 'crm-export', async () => {
      const { CRMExportAgent } = await import('./lead-gen/crm-export-agent.js');
      return new CRMExportAgent().run();
    });

    // ── Step 6: Trigger rules engine ──────────────────────────────────────────
    await this.runStep(steps, 'trigger-rules', async () => {
      const { TriggerRulesEngine } = await import('./trigger-rules-engine.js');
      return new TriggerRulesEngine().run();
    });

    // ── Summary ───────────────────────────────────────────────────────────────
    for (const outcome of Object.values(steps)) {
      if (outcome.status === 'failed') totalErrors++;
    }

    const completedAt = new Date();
    const durationMs = completedAt.getTime() - startedAt.getTime();

    logger.info(
      { runId, durationMs, totalErrors, steps: Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, v.status])) },
      '[MasterScheduler] Weekly pipeline complete'
    );

    return {
      runId,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs,
      steps,
      totalErrors,
    };
  }

  private async runStep(
    steps: Record<string, StepOutcome>,
    name: string,
    fn: () => Promise<unknown>,
  ): Promise<void> {
    const t0 = Date.now();
    try {
      const detail = await fn();
      steps[name] = { status: 'success', durationMs: Date.now() - t0, detail };
      logger.info({ step: name, durationMs: steps[name].durationMs }, `[MasterScheduler] ${name} — success`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      steps[name] = { status: 'failed', durationMs: Date.now() - t0, error };
      logger.error({ step: name, error }, `[MasterScheduler] ${name} — failed (non-fatal, continuing)`);
    }
  }
}
