import { db } from '@/db/index.js';
import { regulatoryFlags, leads } from '@/db/schema.js';
import { logger } from '@/lib/logger.js';
import { eq, inArray, or, sql } from 'drizzle-orm';

type FitResult = { assessed: number; flagged: number; seeded: number };

const SEED_FLAGS = [
  {
    category: 'supplements',
    countryCode: 'DE',
    riskLevel: 'high',
    flagType: 'certification',
    description: 'LFGB + BfR notification mandatory; many US supplement formats prohibited in Germany',
    sourceRegulation: 'LFGB §4',
  },
  {
    category: 'supplements',
    countryCode: 'FR',
    riskLevel: 'medium',
    flagType: 'certification',
    description: 'DGCCRF notification required; positive ingredient list restricts several US-common compounds',
    sourceRegulation: 'Décret 2006-352',
  },
  {
    category: 'supplements',
    countryCode: 'EU',
    riskLevel: 'high',
    flagType: 'novel_food',
    description: 'CBD, mushroom extracts, and adaptogens require Novel Food authorisation under EU 2015/2283',
    sourceRegulation: 'EU Reg 2015/2283',
  },
  {
    category: 'food_beverage',
    countryCode: 'EU',
    riskLevel: 'medium',
    flagType: 'labelling',
    description: 'Allergen labelling rules (Reg 1169/2011) differ significantly from US FD&C Act requirements',
    sourceRegulation: 'EU Reg 1169/2011',
  },
  {
    category: 'food_beverage',
    countryCode: 'EU',
    riskLevel: 'medium',
    flagType: 'ingredient_restriction',
    description: 'Red 40, Yellow 5/6 require "may affect children\'s activity and attention" warning label',
    sourceRegulation: 'EU Reg 1333/2008',
  },
  {
    category: 'cosmetics_personal_care',
    countryCode: 'EU',
    riskLevel: 'medium',
    flagType: 'ingredient_restriction',
    description: '~1400 banned or restricted substances under EU Cosmetics Regulation; US formulas often non-compliant',
    sourceRegulation: 'EU Reg 1223/2009',
  },
  {
    category: 'food_beverage',
    countryCode: 'EU',
    riskLevel: 'low',
    flagType: 'labelling',
    description: '"Organic" claims require EU organic certification — USDA Organic is only partially recognised',
    sourceRegulation: 'EU Reg 2018/848',
  },
] as const;

const RISK_ORDER: Record<string, number> = { low: 1, medium: 2, high: 3 };

export class RegulatoryFitAgent {
  async run(): Promise<FitResult> {
    let assessed = 0;
    let flagged = 0;
    let seeded = 0;

    // Seed regulatory_flags table if empty
    const existing = await db.select({ id: regulatoryFlags.id }).from(regulatoryFlags).limit(1);
    if (existing.length === 0) {
      for (const flag of SEED_FLAGS) {
        await db
          .insert(regulatoryFlags)
          .values(flag)
          .onConflictDoNothing();
        seeded++;
      }
      logger.info({ seeded }, 'RegulatoryFitAgent seeded regulatory_flags');
    }

    // Assess every lead that has a category + country
    const activeLeads = await db
      .select({
        id: leads.id,
        bestCategory: leads.bestCategory,
        bestCountryCode: leads.bestCountryCode,
      })
      .from(leads)
      .where(
        inArray(leads.status, ['new', 'reviewed', 'approved']),
      );

    for (const lead of activeLeads) {
      if (!lead.bestCategory || !lead.bestCountryCode) continue;

      const matchingFlags = await db
        .select({ riskLevel: regulatoryFlags.riskLevel })
        .from(regulatoryFlags)
        .where(
          or(
            sql`${regulatoryFlags.category} = ${lead.bestCategory} AND ${regulatoryFlags.countryCode} = ${lead.bestCountryCode}`,
            sql`${regulatoryFlags.category} = ${lead.bestCategory} AND ${regulatoryFlags.countryCode} = 'EU'`,
          ),
        );

      if (matchingFlags.length === 0) {
        await db
          .update(leads)
          .set({ regulatoryRiskLevel: 'low', updatedAt: new Date() })
          .where(eq(leads.id, lead.id));
        assessed++;
        continue;
      }

      const maxRisk = matchingFlags.reduce((best, f) => {
        return (RISK_ORDER[f.riskLevel] ?? 0) > (RISK_ORDER[best] ?? 0) ? f.riskLevel : best;
      }, 'low');

      await db
        .update(leads)
        .set({ regulatoryRiskLevel: maxRisk, updatedAt: new Date() })
        .where(eq(leads.id, lead.id));

      assessed++;
      if (maxRisk !== 'low') flagged++;
    }

    logger.info({ assessed, flagged, seeded }, 'RegulatoryFitAgent completed');
    return { assessed, flagged, seeded };
  }
}
