import { db } from '@/db/index.js';
import { leads, leadCampaigns, leadPipeline, leadBriefings } from '@/db/schema.js';
import { logger } from '@/lib/logger.js';
import { eq, and, or, inArray, isNull, lt, desc } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import * as fs from 'fs/promises';
import * as path from 'path';

type CRMExportResult = {
  exported: number;
  filePath: string;
};

export class CRMExportAgent {
  async run(): Promise<CRMExportResult> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const exportLeads = await db
      .select({
        id: leads.id,
        companyName: leads.companyName,
        contactName: leads.contactName,
        email: leads.email,
        websiteUrl: leads.websiteUrl,
        linkedinUrl: leads.linkedinUrl,
        status: leads.status,
        leadType: leads.leadType,
        discoverySource: leads.discoverySource,
        leadQualityScore: leads.leadQualityScore,
        pitchAngle: leads.pitchAngle,
        pitchSummary: leads.pitchSummary,
        bestCategory: leads.bestCategory,
        bestCountryCode: leads.bestCountryCode,
        trendTier: leads.trendTier,
        assignedTo: leads.assignedTo,
        createdAt: leads.createdAt,
      })
      .from(leads)
      .where(
        or(
          inArray(leads.status, ['replied', 'qualified', 'won']),
          and(
            sql`leads.lead_quality_score >= 75`,
            or(
              isNull(leads.crmExportedAt),
              lt(leads.crmExportedAt, sevenDaysAgo),
            ),
          ),
        ),
      )
      .orderBy(desc(leads.leadQualityScore));

    const enriched = await Promise.all(exportLeads.map(async (lead) => {
      const [campaign, pipeline, briefing] = await Promise.all([
        db.select({ status: leadCampaigns.status, sentAt: leadCampaigns.sentAt, subject: leadCampaigns.subject })
          .from(leadCampaigns).where(eq(leadCampaigns.leadId, lead.id))
          .orderBy(desc(leadCampaigns.createdAt)).limit(1),
        db.select({ stage: leadPipeline.stage, estimatedValue: leadPipeline.estimatedValue, probabilityPercent: leadPipeline.probabilityPercent })
          .from(leadPipeline).where(eq(leadPipeline.leadId, lead.id)).limit(1),
        db.select({ title: leadBriefings.title })
          .from(leadBriefings).where(eq(leadBriefings.leadId, lead.id)).limit(1),
      ]);

      return {
        ...lead,
        lastCampaign: campaign[0] ?? null,
        pipeline: pipeline[0] ?? null,
        briefingTitle: briefing[0]?.title ?? null,
      };
    }));

    const isoDate = new Date().toISOString().split('T')[0];
    const exportDir = path.resolve(process.cwd(), '..', '..', 'exports');
    await fs.mkdir(exportDir, { recursive: true });
    const filePath = path.join(exportDir, `crm-leads-${isoDate}.json`);

    await fs.writeFile(filePath, JSON.stringify(enriched, null, 2), 'utf8');

    // Update crmExportedAt
    const ids = exportLeads.map(l => l.id);
    if (ids.length > 0) {
      await db
        .update(leads)
        .set({ crmExportedAt: new Date() })
        .where(inArray(leads.id, ids));
    }

    logger.info({ exported: enriched.length, filePath }, 'CRM export completed');
    return { exported: enriched.length, filePath };
  }
}
