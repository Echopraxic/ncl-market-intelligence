// Report Generator Agent — produces weekly and monthly executive digests.
//
// Report types:
//   'weekly_report' — top 5 corridors, pipeline summary, new insights count.
//                     Deduplication: one per ISO week (same as InsightGenerationAgent).
//   'monthly_report' — top corridors for the calendar month, aggregate lead pipeline stats.
//                      Written as a 'market_brief' insight type (fits existing enum).
//
// Written to the insights table so they appear in the Insights Feed dashboard page
// and the new /reports page.

import { db } from '../../db/index.js';
import { insights, opportunityScores, leads, humanReviewItems, trends } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import { desc, gte, eq, and, isNull, sql, count } from 'drizzle-orm';

const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';

type ReportResult = {
  weeklyReportWritten: boolean;
  monthlyReportWritten: boolean;
  total: number;
};

export class ReportGeneratorAgent {
  async run(): Promise<ReportResult> {
    let weeklyReportWritten = false;
    let monthlyReportWritten = false;

    weeklyReportWritten  = await this.generateWeeklyReport();
    monthlyReportWritten = await this.generateMonthlyReport();

    const total = (weeklyReportWritten ? 1 : 0) + (monthlyReportWritten ? 1 : 0);
    logger.info({ weeklyReportWritten, monthlyReportWritten }, '[ReportGenerator] Complete');
    return { weeklyReportWritten, monthlyReportWritten, total };
  }

  // ── Weekly report ──────────────────────────────────────────────────────────

  private async generateWeeklyReport(): Promise<boolean> {
    const now = new Date();
    const isoWeek = this.getISOWeek(now);
    const title = `Weekly Intelligence Digest — Week ${isoWeek}, ${now.getFullYear()}`;

    // Dedup: skip if we already wrote this week's report
    const existing = await db
      .select({ id: insights.id })
      .from(insights)
      .where(and(eq(insights.title, title), eq(insights.type, 'weekly_report')))
      .limit(1);

    if (existing.length > 0) {
      logger.info({ title }, '[ReportGenerator] Weekly report already exists — skipping');
      return false;
    }

    // Top 5 corridors by composite score
    const topCorridors = await db
      .select({
        category:       opportunityScores.category,
        countryCode:    opportunityScores.countryCode,
        compositeScore: opportunityScores.compositeScore,
      })
      .from(opportunityScores)
      .where(isNull(opportunityScores.brandId))
      .orderBy(desc(opportunityScores.compositeScore))
      .limit(5);

    // Lead pipeline stats (last 7 days)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [leadsRow] = await db
      .select({ total: count() })
      .from(leads)
      .where(gte(leads.createdAt, sevenDaysAgo));

    const [pendingReviewRow] = await db
      .select({ total: count() })
      .from(humanReviewItems)
      .where(eq(humanReviewItems.status, 'pending'));

    // New breakthrough trends this week
    const breakthroughTrends = await db
      .select({ category: trends.category, countryCode: trends.countryCode, growthRate: trends.growthRate })
      .from(trends)
      .where(and(eq(trends.opportunityTier, 'breakthrough'), gte(trends.createdAt, sevenDaysAgo)))
      .limit(5);

    const corridorLines = topCorridors.length > 0
      ? topCorridors.map((c, i) =>
          `  ${i + 1}. ${c.category} × ${c.countryCode}: composite ${(c.compositeScore ?? 0).toFixed(1)}`
        ).join('\n')
      : '  No corridor data yet — run scoring agents.';

    const breakthroughLines = breakthroughTrends.length > 0
      ? breakthroughTrends.map(t =>
          `  • ${t.category} × ${t.countryCode} (+${((t.growthRate ?? 0) * 100).toFixed(1)}% YoY)`
        ).join('\n')
      : '  None detected this week.';

    const ruleBasedBody =
      `TOP CORRIDORS (composite score):\n${corridorLines}\n\n` +
      `BREAKTHROUGH TRENDS THIS WEEK:\n${breakthroughLines}\n\n` +
      `PIPELINE METRICS:\n` +
      `  New leads (7d): ${leadsRow?.total ?? 0}\n` +
      `  Pending human review items: ${pendingReviewRow?.total ?? 0}`;

    const body = await this.generateNarrative('weekly', { topCorridors, leadsRow, pendingReviewRow, breakthroughTrends }, ruleBasedBody);

    await db.insert(insights).values({
      type: 'weekly_report',
      title,
      body,
      status: 'draft',
    });

    logger.info({ title }, '[ReportGenerator] Weekly report written');
    return true;
  }

  // ── Monthly report ─────────────────────────────────────────────────────────

  private async generateMonthlyReport(): Promise<boolean> {
    const now = new Date();
    const monthName = now.toLocaleString('default', { month: 'long' });
    const title = `Monthly Market Brief — ${monthName} ${now.getFullYear()}`;

    // Dedup: skip if this month's brief already exists
    const existing = await db
      .select({ id: insights.id })
      .from(insights)
      .where(and(eq(insights.title, title), eq(insights.type, 'market_brief')))
      .limit(1);

    if (existing.length > 0) {
      logger.info({ title }, '[ReportGenerator] Monthly report already exists — skipping');
      return false;
    }

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // Top 10 corridors
    const topCorridors = await db
      .select({
        category:       opportunityScores.category,
        countryCode:    opportunityScores.countryCode,
        compositeScore: opportunityScores.compositeScore,
        categoryScore:  opportunityScores.categoryOpportunityScore,
        niScore:        opportunityScores.niSuitabilityPreScore,
      })
      .from(opportunityScores)
      .where(isNull(opportunityScores.brandId))
      .orderBy(desc(opportunityScores.compositeScore))
      .limit(10);

    // Lead pipeline totals
    const [totalLeadsRow] = await db.select({ total: count() }).from(leads);
    const [qualifiedRow] = await db
      .select({ total: count() })
      .from(leads)
      .where(eq(leads.status, 'qualified'));

    // Trends published this month
    const [trendsRow] = await db
      .select({ total: count() })
      .from(trends)
      .where(gte(trends.createdAt, thirtyDaysAgo));

    const corridorLines = topCorridors.length > 0
      ? topCorridors.map((c, i) =>
          `  ${i + 1}. ${c.category} × ${c.countryCode}: composite ${(c.compositeScore ?? 0).toFixed(1)} (category ${(c.categoryScore ?? 0).toFixed(1)}, NI ${(c.niScore ?? 0).toFixed(1)})`
        ).join('\n')
      : '  No corridor data yet.';

    const ruleBasedBody =
      `MONTHLY MARKET BRIEF: ${monthName} ${now.getFullYear()}\n\n` +
      `TOP 10 CORRIDORS:\n${corridorLines}\n\n` +
      `PIPELINE SUMMARY:\n` +
      `  Total leads in system: ${totalLeadsRow?.total ?? 0}\n` +
      `  Qualified leads: ${qualifiedRow?.total ?? 0}\n` +
      `  Trends detected (30d): ${trendsRow?.total ?? 0}`;

    const body = await this.generateNarrative('monthly', { topCorridors, totalLeadsRow, qualifiedRow, trendsRow }, ruleBasedBody);

    await db.insert(insights).values({
      type: 'market_brief',
      title,
      body,
      status: 'draft',
    });

    logger.info({ title }, '[ReportGenerator] Monthly report written');
    return true;
  }

  // ── AI narrative ───────────────────────────────────────────────────────────

  private async generateNarrative(
    reportType: 'weekly' | 'monthly',
    data: Record<string, unknown>,
    fallback: string,
  ): Promise<string> {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return fallback;

    const prompt = reportType === 'weekly'
      ? `You are a market intelligence analyst for North Channel Logistics (NCL), an EU logistics consultancy specialising in Northern Ireland routing. Write a concise weekly executive digest (200–300 words) covering: top EU opportunity corridors, breakthrough trends, and lead pipeline activity. Data: ${JSON.stringify(data, null, 2)}. Be direct, use specific numbers, highlight the single most actionable insight.`
      : `You are a market intelligence analyst for North Channel Logistics (NCL). Write a monthly market brief (300–500 words) covering top EU expansion corridors, pipeline health, and strategic recommendations for the coming month. Data: ${JSON.stringify(data, null, 2)}. Be direct and commercially focused. Identify 1–2 corridors NCL should prioritise next month.`;

    try {
      const response = await fetch(DEEPSEEK_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: reportType === 'weekly' ? 500 : 800,
          temperature: 0.4,
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) throw new Error(`DeepSeek ${response.status}`);
      const json = await response.json() as { choices: Array<{ message: { content: string } }> };
      const narrative = json.choices?.[0]?.message?.content?.trim();
      if (!narrative) throw new Error('Empty response');

      return `${narrative}\n\n---\n${fallback}`;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, '[ReportGenerator] DeepSeek failed — using template body');
      return fallback;
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private getISOWeek(date: Date): number {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
    const yearStart = new Date(d.getFullYear(), 0, 4);
    return 1 + Math.round(((d.getTime() - yearStart.getTime()) / 86400000 - 3 + ((yearStart.getDay() + 6) % 7)) / 7);
  }
}
