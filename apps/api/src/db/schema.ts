import { pgTable, uuid, text, boolean, integer, real, jsonb, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const signalSourceEnum = pgEnum('signal_source', ['google_trends','amazon_eu','social','retailer','trade_data']);
export const signalTypeEnum = pgEnum('signal_type', ['demand','supply','trend','gap']);
export const activityTypeEnum = pgEnum('activity_type', ['new_listing','category_expansion','seasonal_rotation']);
export const insightTypeEnum = pgEnum('insight_type', ['weekly_report','opportunity_alert','trade_show_playbook','market_brief']);
export const insightStatusEnum = pgEnum('insight_status', ['draft','published','sent']);
export const campaignTypeEnum = pgEnum('campaign_type', ['email','linkedin','phone']);
export const campaignStatusEnum = pgEnum('campaign_status', ['queued','sent','opened','replied']);
export const crawlStatusEnum = pgEnum('crawl_status', ['pending','running','completed','failed']);

export const brands = pgTable('brands', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  websiteUrl: text('website_url'),
  shopifyStoreUrl: text('shopify_store_url'),
  categories: text('categories').array(),
  annualRevenueEstimate: real('annual_revenue_estimate'),
  employeeCount: integer('employee_count'),
  foundedYear: integer('founded_year'),
  country: text('country').notNull().default('US'),
  euPresence: boolean('eu_presence').default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (t) => ({ idx: index('brands_categories_idx').on(t.categories) }));

export const products = pgTable('products', {
  id: uuid('id').primaryKey().defaultRandom(),
  brandId: uuid('brand_id').notNull().references(() => brands.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  categoryPath: text('category_path'),
  priceUsd: real('price_usd'),
  hsCode: text('hs_code'),
  imageUrl: text('image_url'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const euMarketSignals = pgTable('eu_market_signals', {
  id: uuid('id').primaryKey().defaultRandom(),
  source: signalSourceEnum('source').notNull(),
  countryCode: text('country_code').notNull(),
  category: text('category').notNull(),
  signalType: signalTypeEnum('signal_type').notNull(),
  signalValue: real('signal_value').notNull(),
  rawData: jsonb('raw_data'),
  capturedAt: timestamp('captured_at').notNull().defaultNow(),
}, (t) => ({ idx: index('eu_signals_country_category_time_idx').on(t.countryCode, t.category, t.capturedAt) }));

export const tradeShows = pgTable('trade_shows', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  location: text('location'),
  countryCode: text('country_code'),
  startDate: timestamp('start_date'),
  endDate: timestamp('end_date'),
  categories: text('categories').array(),
  websiteUrl: text('website_url'),
  exhibitorCount: integer('exhibitor_count'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const tradeShowExhibitors = pgTable('trade_show_exhibitors', {
  id: uuid('id').primaryKey().defaultRandom(),
  tradeShowId: uuid('trade_show_id').notNull().references(() => tradeShows.id, { onDelete: 'cascade' }),
  brandName: text('brand_name').notNull(),
  brandWebsite: text('brand_website'),
  categories: text('categories').array(),
  boothInfo: text('booth_info'),
});

export const distributors = pgTable('distributors', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  countryCode: text('country_code').notNull(),
  categories: text('categories').array(),
  brandsCarried: text('brands_carried').array(),
  websiteUrl: text('website_url'),
  contactInfo: jsonb('contact_info'),
  importsUsGoods: boolean('imports_us_goods').default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const retailerActivities = pgTable('retailer_activities', {
  id: uuid('id').primaryKey().defaultRandom(),
  retailerName: text('retailer_name').notNull(),
  countryCode: text('country_code').notNull(),
  activityType: activityTypeEnum('activity_type').notNull(),
  category: text('category'),
  details: jsonb('details'),
  detectedAt: timestamp('detected_at').notNull().defaultNow(),
});

export const opportunityScores = pgTable('opportunity_scores', {
  id: uuid('id').primaryKey().defaultRandom(),
  brandId: uuid('brand_id').references(() => brands.id, { onDelete: 'set null' }),
  category: text('category').notNull(),
  countryCode: text('country_code').notNull(),
  categoryOpportunityScore: real('category_opportunity_score').notNull().default(0),
  brandFitScore: real('brand_fit_score').notNull().default(0),
  niSuitabilityPreScore: real('ni_suitability_pre_score').notNull().default(0),
  compositeScore: real('composite_score').notNull().default(0),
  scoringFactors: jsonb('scoring_factors'),
  generatedAt: timestamp('generated_at').notNull().defaultNow(),
}, (t) => ({ idx: index('opportunity_scores_composite_idx').on(t.compositeScore, t.generatedAt) }));

export const insights = pgTable('insights', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: insightTypeEnum('type').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  relatedOpportunities: uuid('related_opportunities').array(),
  status: insightStatusEnum('status').notNull().default('draft'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const outreachCampaigns = pgTable('outreach_campaigns', {
  id: uuid('id').primaryKey().defaultRandom(),
  brandId: uuid('brand_id').notNull().references(() => brands.id, { onDelete: 'cascade' }),
  insightId: uuid('insight_id').references(() => insights.id, { onDelete: 'set null' }),
  campaignType: campaignTypeEnum('campaign_type').notNull(),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  status: campaignStatusEnum('status').notNull().default('queued'),
  sentAt: timestamp('sent_at'),
  openedAt: timestamp('opened_at'),
  repliedAt: timestamp('replied_at'),
});

export const crawlJobs = pgTable('crawl_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  crawlerType: text('crawler_type').notNull(),
  status: crawlStatusEnum('status').notNull().default('pending'),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  recordsFound: integer('records_found'),
  errorLog: text('error_log'),
}, (t) => ({ idx: index('crawl_jobs_type_status_idx').on(t.crawlerType, t.status) }));

// Phase 2 Tables
export const trends = pgTable('trends', {
  id: uuid('id').primaryKey().defaultRandom(),
  category: text('category').notNull(),
  countryCode: text('country_code').notNull(),
  growthRate: real('growth_rate').notNull(),
  periodStart: timestamp('period_start').notNull(),
  periodEnd: timestamp('period_end').notNull(),
  confidence: real('confidence').notNull(),
  signalIds: uuid('signal_ids').array(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const agentOutputs = pgTable('agent_outputs', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentType: text('agent_type').notNull(),
  outputData: jsonb('output_data').notNull(),
  relatedEntityIds: uuid('related_entity_ids').array(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const triggerRules = pgTable('trigger_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  ruleName: text('rule_name').notNull().unique(),
  conditions: jsonb('conditions').notNull(),
  actionType: text('action_type').notNull(),
  actionConfig: jsonb('action_config').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// Relations
export const brandsRelations = relations(brands, ({ many }) => ({
  products: many(products),
  opportunityScores: many(opportunityScores),
  outreachCampaigns: many(outreachCampaigns),
}));
export const productsRelations = relations(products, ({ one }) => ({
  brand: one(brands, { fields: [products.brandId], references: [brands.id] }),
}));
export const tradeShowsRelations = relations(tradeShows, ({ many }) => ({
  exhibitors: many(tradeShowExhibitors),
}));
export const tradeShowExhibitorsRelations = relations(tradeShowExhibitors, ({ one }) => ({
  tradeShow: one(tradeShows, { fields: [tradeShowExhibitors.tradeShowId], references: [tradeShows.id] }),
}));
export const opportunityScoresRelations = relations(opportunityScores, ({ one }) => ({
  brand: one(brands, { fields: [opportunityScores.brandId], references: [brands.id] }),
}));
export const outreachCampaignsRelations = relations(outreachCampaigns, ({ one }) => ({
  brand: one(brands, { fields: [outreachCampaigns.brandId], references: [brands.id] }),
  insight: one(insights, { fields: [outreachCampaigns.insightId], references: [insights.id] }),
}));
