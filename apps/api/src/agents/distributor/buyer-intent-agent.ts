import { db } from '@/db/index.js';
import { distributors, distributorBuyingIntent, agentOutputs, tradeShowExhibitors, tradeShows } from '@/db/schema.js';
import { logger } from '@/lib/logger.js';
import { eq, sql } from 'drizzle-orm';

type IntentResult = { updated: number };

// Buying-role job title keywords that signal active sourcing
const BUYER_ROLE_KEYWORDS = ['buyer', 'purchasing', 'procurement', 'category manager', 'buying manager', 'head of buying', 'sourcing'];

export class BuyerIntentAgent {
  async run(): Promise<IntentResult> {
    let updated = 0;

    const allDistributors = await db
      .select({ id: distributors.id, name: distributors.name, categories: distributors.categories, description: distributors.description, linkedinUrl: distributors.linkedinUrl })
      .from(distributors);

    for (const dist of allDistributors) {
      const intentMap = new Map<string, { strength: number; sources: string[]; signals: object }>();

      // Signal 1: Existing categories field → baseline intent 0.3
      for (const cat of (dist.categories ?? [])) {
        const normalized = this.normalizeCategory(cat);
        if (normalized) this.addIntent(intentMap, normalized, 0.3, 'directory', { category: cat });
      }

      // Signal 2: Description text keywords → intent 0.4
      if (dist.description) {
        const descLower = dist.description.toLowerCase();
        const cat = this.inferCategoryFromText(descLower);
        if (cat) this.addIntent(intentMap, cat, 0.4, 'directory', { descriptionHint: descLower.slice(0, 80) });
      }

      // Signal 3: Trade show presence → intent 0.7
      const tradeShowMatches = await db
        .select({ categories: tradeShows.categories })
        .from(tradeShowExhibitors)
        .innerJoin(tradeShows, eq(tradeShowExhibitors.tradeShowId, tradeShows.id))
        .where(sql`lower(${tradeShowExhibitors.brandName}) = lower(${dist.name})`);

      for (const show of tradeShowMatches) {
        for (const cat of (show.categories ?? [])) {
          const normalized = this.normalizeCategory(cat);
          if (normalized) this.addIntent(intentMap, normalized, 0.7, 'trade_show', { showCategory: cat });
        }
      }

      // Signal 4: LinkedIn job role signal → intent 0.9
      if (dist.linkedinUrl) {
        const linkedinOutputs = await db
          .select({ outputData: agentOutputs.outputData })
          .from(agentOutputs)
          .where(sql`agent_type = 'linkedin' AND output_data::text ILIKE ${'%' + dist.name + '%'}`)
          .limit(1);

        for (const output of linkedinOutputs) {
          const data = output.outputData as Record<string, unknown>;
          const roles = (data.jobTitles ?? data.employeeGrowthSignal ?? '') as string;
          const rolesLower = roles.toLowerCase();
          if (BUYER_ROLE_KEYWORDS.some(kw => rolesLower.includes(kw))) {
            for (const cat of (dist.categories ?? [])) {
              const normalized = this.normalizeCategory(cat);
              if (normalized) this.addIntent(intentMap, normalized, 0.9, 'linkedin_job', { roles });
            }
          }
        }
      }

      // Upsert intent rows for each category with intent > 0.2
      for (const [category, { strength, sources, signals }] of intentMap) {
        if (strength < 0.2) continue;

        await db
          .insert(distributorBuyingIntent)
          .values({
            distributorId: dist.id,
            category,
            intentStrength: Math.min(strength, 1.0),
            signals: { sources, ...signals } as unknown,
            source: sources[0] ?? 'directory',
            detectedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [distributorBuyingIntent.distributorId, distributorBuyingIntent.category],
            set: {
              intentStrength: Math.min(strength, 1.0),
              signals: { sources, ...signals } as unknown,
              source: sources[0] ?? 'directory',
              detectedAt: new Date(),
            },
          });
        updated++;
      }
    }

    logger.info({ updated }, 'BuyerIntentAgent completed');
    return { updated };
  }

  private addIntent(
    map: Map<string, { strength: number; sources: string[]; signals: object }>,
    category: string,
    strength: number,
    source: string,
    signals: object,
  ): void {
    const existing = map.get(category);
    if (existing) {
      existing.strength = Math.max(existing.strength, strength);
      if (!existing.sources.includes(source)) existing.sources.push(source);
    } else {
      map.set(category, { strength, sources: [source], signals });
    }
  }

  private inferCategoryFromText(text: string): string | null {
    if (text.includes('food') || text.includes('beverage') || text.includes('drink') || text.includes('snack') || text.includes('grocery')) return 'food_beverage';
    if (text.includes('supplement') || text.includes('vitamin') || text.includes('nutraceutical') || text.includes('wellness')) return 'supplements';
    if (text.includes('cosmetic') || text.includes('beauty') || text.includes('skincare') || text.includes('personal care')) return 'cosmetics_personal_care';
    if (text.includes('home') || text.includes('household') || text.includes('furniture') || text.includes('decor')) return 'home_goods';
    if (text.includes('toy') || text.includes('game') || text.includes('play')) return 'toys_games';
    return null;
  }

  private normalizeCategory(raw: string): string | null {
    const lower = raw.toLowerCase().trim();
    if (lower.includes('food') || lower.includes('beverage') || lower.includes('drink') || lower.includes('snack')) return 'food_beverage';
    if (lower.includes('supplement') || lower.includes('vitamin') || lower.includes('health') || lower.includes('nutraceutical')) return 'supplements';
    if (lower.includes('cosmetic') || lower.includes('beauty') || lower.includes('skincare') || lower.includes('personal care')) return 'cosmetics_personal_care';
    if (lower.includes('home') || lower.includes('household') || lower.includes('furniture') || lower.includes('decor')) return 'home_goods';
    if (lower.includes('toy') || lower.includes('game') || lower.includes('play')) return 'toys_games';
    // Check direct NCL category names
    const NCL_CATS = ['food_beverage', 'supplements', 'cosmetics_personal_care', 'home_goods', 'toys_games'];
    if (NCL_CATS.includes(lower)) return lower;
    return null;
  }
}
