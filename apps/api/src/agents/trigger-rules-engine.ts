// Trigger Rules Engine — reads `trigger_rules` table and fires actions when
// opportunity_scores rows meet rule conditions.
//
// Currently supported action types:
//   - 'alert_insight'     : write an opportunity_alert insight to the insights table
//   - 'queue_outreach'    : set lead status to 'approved' (requires human send approval per policy)
//   - 'approve_lead'      : same as queue_outreach — alias
//
// Condition schema (stored as JSONB in trigger_rules.conditions):
//   { metric: 'compositeScore' | 'categoryScore' | 'brandFitScore', operator: '>', threshold: number }
//
// Note: outreach emails are NEVER sent automatically per CLAUDE.md automation policy.
// This engine only marks leads for review — a human must approve sending.

import { db } from '../db/index.js';
import { triggerRules, opportunityScores, insights, leads } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { eq, gt, and, desc, sql } from 'drizzle-orm';

type RuleCondition = {
  metric: 'compositeScore' | 'categoryScore' | 'brandFitScore';
  operator: '>';
  threshold: number;
};

type RuleAction = {
  type: 'alert_insight' | 'queue_outreach' | 'approve_lead';
  [key: string]: unknown;
};

type TriggerRulesResult = {
  rulesEvaluated: number;
  alertsCreated: number;
  leadsQueued: number;
};

export class TriggerRulesEngine {
  async run(): Promise<TriggerRulesResult> {
    let alertsCreated = 0;
    let leadsQueued = 0;

    // Load all active rules
    const rules = await db
      .select()
      .from(triggerRules)
      .where(eq(triggerRules.isActive, true));

    if (rules.length === 0) {
      logger.info('[TriggerRulesEngine] No active trigger rules — nothing to do');
      return { rulesEvaluated: 0, alertsCreated: 0, leadsQueued: 0 };
    }

    logger.info({ count: rules.length }, '[TriggerRulesEngine] Evaluating rules against opportunity_scores');

    for (const rule of rules) {
      try {
        const condition = rule.conditions as RuleCondition;
        const action = rule.actionConfig as RuleAction;

        if (!condition?.metric || !condition?.threshold) {
          logger.warn({ ruleName: rule.ruleName }, '[TriggerRulesEngine] Malformed condition — skipping');
          continue;
        }

        // Query scores meeting the condition
        const scoreColumn = this.getScoreColumn(condition.metric);
        if (!scoreColumn) {
          logger.warn({ metric: condition.metric }, '[TriggerRulesEngine] Unknown metric — skipping');
          continue;
        }

        const matchingScores = await db
          .select()
          .from(opportunityScores)
          .where(gt(scoreColumn, condition.threshold))
          .orderBy(desc(scoreColumn))
          .limit(50);

        if (matchingScores.length === 0) continue;

        logger.info(
          { ruleName: rule.ruleName, matched: matchingScores.length, action: action.type },
          '[TriggerRulesEngine] Rule fired'
        );

        for (const score of matchingScores) {
          if (action.type === 'alert_insight') {
            const created = await this.createAlertInsight(score, rule.ruleName, condition);
            if (created) alertsCreated++;
          } else if (action.type === 'queue_outreach' || action.type === 'approve_lead') {
            if (score.brandId) {
              const queued = await this.queueLeadForOutreach(score.brandId);
              if (queued) leadsQueued++;
            }
          }
        }
      } catch (err) {
        logger.error({ ruleName: rule.ruleName, err }, '[TriggerRulesEngine] Rule evaluation failed (non-fatal)');
      }
    }

    logger.info({ rulesEvaluated: rules.length, alertsCreated, leadsQueued }, '[TriggerRulesEngine] Complete');
    return { rulesEvaluated: rules.length, alertsCreated, leadsQueued };
  }

  private getScoreColumn(metric: string) {
    switch (metric) {
      case 'compositeScore':    return opportunityScores.compositeScore;
      case 'categoryScore':     return opportunityScores.categoryOpportunityScore;
      case 'brandFitScore':     return opportunityScores.brandFitScore;
      default: return null;
    }
  }

  private async createAlertInsight(
    score: typeof opportunityScores.$inferSelect,
    ruleName: string,
    condition: RuleCondition,
  ): Promise<boolean> {
    const title = `High-Score Alert: ${score.category} × ${score.countryCode} (composite ${(score.compositeScore ?? 0).toFixed(1)})`;

    // 7-day deduplication: don't re-alert on the same corridor within a week
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const existing = await db
      .select({ id: insights.id })
      .from(insights)
      .where(
        and(
          eq(insights.title, title),
          sql`${insights.createdAt} >= ${sevenDaysAgo.toISOString()}`,
        )
      )
      .limit(1);

    if (existing.length > 0) return false;

    const body =
      `Rule "${ruleName}" fired: ${condition.metric} > ${condition.threshold}.\n` +
      `Corridor: ${score.category} × ${score.countryCode}\n` +
      `Composite: ${(score.compositeScore ?? 0).toFixed(1)} | Category: ${(score.categoryOpportunityScore ?? 0).toFixed(1)} | Brand Fit: ${(score.brandFitScore ?? 0).toFixed(1)} | NI Suitability: ${(score.niSuitabilityPreScore ?? 0).toFixed(1)}\n` +
      (score.brandId ? `Brand ID: ${score.brandId}\n` : '') +
      `Triggered at: ${new Date().toISOString()}`;

    await db.insert(insights).values({
      type: 'opportunity_alert',
      title,
      body,
      status: 'published',
    });

    return true;
  }

  private async queueLeadForOutreach(brandId: string): Promise<boolean> {
    // Mark any 'new' or 'reviewed' lead for this brand as 'approved' (still needs human send approval)
    const result = await db
      .update(leads)
      .set({ status: 'approved' })
      .where(
        and(
          eq(leads.brandId, brandId),
          sql`${leads.status} IN ('new', 'reviewed')`,
        )
      );

    // Drizzle returns rowCount on update
    return (result as any)?.rowCount > 0;
  }
}
