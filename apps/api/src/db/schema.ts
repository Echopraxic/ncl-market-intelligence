import { pgTable, uuid, text, boolean, integer, real, jsonb, timestamp, pgEnum, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

export const signalSourceEnum = pgEnum('signal_source', ['google_trends','amazon_eu','social','retailer','trade_data']);
export const signalTypeEnum = pgEnum('signal_type', ['demand','supply','trend','gap']);
export const activityTypeEnum = pgEnum('activity_type', ['new_listing','category_expansion','seasonal_rotation']);
export const insightTypeEnum = pgEnum('insight_type', ['weekly_report','opportunity_alert','trade_show_playbook','market_brief']);
export const insightStatusEnum = pgEnum('insight_status', ['draft','published','sent']);
export const campaignTypeEnum = pgEnum('campaign_type', ['email','linkedin','phone']);
export const campaignStatusEnum = pgEnum('campaign_status', ['queued','sent','opened','replied']);
export const crawlStatusEnum = pgEnum('crawl_status', ['pending','running','completed','failed']);
export const leadStatusEnum = pgEnum('lead_status', ['new','reviewed','approved','contacted','replied','qualified','won','lost','invalid']);
export const pipelineStageEnum = pgEnum('pipeline_stage', ['prospecting','engaged','qualified','proposal','negotiation','closed_won','closed_lost']);

export const brands = pgTable('brands', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  websiteUrl: text('website_url'),
  shopifyStoreUrl: text('shopify_store_url'),
  categories: text('categories').array(),
  annualRevenueEstimate: real('annual_revenue_estimate'),
  employeeCount: integer('employee_count'),
  foundedYear: integer('founded_year'),
  country: text('country'),
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
}, (t) => ({
  idx: index('eu_signals_country_category_time_idx').on(t.countryCode, t.category, t.capturedAt),
  // Prevents the Google Trends backfill (and any other historical insert path)
  // from creating duplicate rows on re-run. Targeted by onConflictDoNothing.
  uniq: uniqueIndex('eu_signals_source_country_category_captured_uniq')
    .on(t.source, t.countryCode, t.category, t.capturedAt),
}));

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

/**
 * Structured trade show playbooks produced by TradeShowPlaybookAgent.
 * One row per trade show (upserted on each run via unique index on tradeShowId).
 *
 * Extends InsightGenerationAgent's basic trade_show_playbook insights with:
 *   exhibitorMatches   — each exhibitor cross-referenced against our brands DB;
 *                        matched brands include composite scores + pitch angles
 *   distributorCoverage — per (category, country) corridor: distributor count +
 *                         gap flag; surfaces broker network opportunities
 *   topPipelineBrands  — highest-scored pipeline brands in matching categories
 *                        (not necessarily exhibiting) for benchmarking
 */
export const tradeShowPlaybooks = pgTable('trade_show_playbooks', {
  id: uuid('id').primaryKey().defaultRandom(),
  tradeShowId: uuid('trade_show_id').notNull().references(() => tradeShows.id, { onDelete: 'cascade' }),
  matchedCategories: text('matched_categories').array().notNull().default(sql`'{}'::text[]`),
  /** Array of { category, countryCode, compositeScore } — corridor scores intersecting with show */
  relevantCorridors: jsonb('relevant_corridors').notNull().default(sql`'[]'::jsonb`),
  /** Array of { brandName, brandId?, compositeScore?, brandFitScore?, niScore?, annualRevenue?, euPresence?, hasShopify, pitchAngle } */
  exhibitorMatches: jsonb('exhibitor_matches').notNull().default(sql`'[]'::jsonb`),
  /** Array of { category, countryCode, distributorCount, distributorNames[], coverageGap } */
  distributorCoverage: jsonb('distributor_coverage').notNull().default(sql`'[]'::jsonb`),
  /** Array of { brandName, brandId, compositeScore, category, countryCode } */
  topPipelineBrands: jsonb('top_pipeline_brands').notNull().default(sql`'[]'::jsonb`),
  totalExhibitors: integer('total_exhibitors').notNull().default(0),
  matchedExhibitors: integer('matched_exhibitors').notNull().default(0),
  narrative: text('narrative').notNull(),
  status: text('status').notNull().default('draft'),
  generatedAt: timestamp('generated_at').notNull().defaultNow(),
}, (t) => ({
  tradeShowUniq: uniqueIndex('tsp_trade_show_uniq').on(t.tradeShowId),
  statusIdx: index('tsp_status_idx').on(t.status, t.generatedAt),
}));

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
}, (t) => ({
  idx: index('opportunity_scores_composite_idx').on(t.compositeScore, t.generatedAt),
  // Partial unique indexes so corridor rows (brandId IS NULL) and brand rows
  // (brandId IS NOT NULL) can share the same (category, countryCode) without
  // conflicting with each other.
  categoryCountryUniq: uniqueIndex('opp_scores_category_country_uniq')
    .on(t.category, t.countryCode)
    .where(sql`brand_id IS NULL`),
  brandCategoryCountryUniq: uniqueIndex('opp_scores_brand_category_country_uniq')
    .on(t.brandId, t.category, t.countryCode)
    .where(sql`brand_id IS NOT NULL`),
}));

export const insights = pgTable('insights', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: insightTypeEnum('type').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  relatedOpportunities: uuid('related_opportunities').array(),
  status: insightStatusEnum('status').notNull().default('draft'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// @deprecated — use lead_campaigns. Retained for schema compatibility.
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

// ---------------------------------------------------------------------------
// Lead Generation Engine Tables (Phase 4)
// ---------------------------------------------------------------------------

export const leads = pgTable('leads', {
  id:                    uuid('id').primaryKey().defaultRandom(),
  companyName:           text('company_name').notNull(),
  contactName:           text('contact_name'),
  email:                 text('email'),
  linkedinUrl:           text('linkedin_url'),
  websiteUrl:            text('website_url'),
  leadType:              text('lead_type').notNull(),
  discoverySource:       text('discovery_source').notNull(),
  brandId:               uuid('brand_id').references(() => brands.id, { onDelete: 'set null' }),
  leadQualityScore:      real('lead_quality_score').notNull().default(0),
  opportunityScore:      real('opportunity_score'),
  gapScore:              real('gap_score'),
  trendTier:             text('trend_tier'),
  bestCategory:          text('best_category'),
  bestCountryCode:       text('best_country_code'),
  pitchAngle:            text('pitch_angle'),
  pitchSummary:          text('pitch_summary'),
  categories:            text('categories').array(),
  annualRevenueEstimate: real('annual_revenue_estimate'),
  employeeCount:         integer('employee_count'),
  euPresence:            boolean('eu_presence').default(false),
  employeeGrowthSignal:  text('employee_growth_signal'),
  status:                leadStatusEnum('status').notNull().default('new'),
  assignedTo:            text('assigned_to'),
  notes:                 text('notes'),
  crmExportedAt:         timestamp('crm_exported_at'),
  createdAt:             timestamp('created_at').notNull().defaultNow(),
  updatedAt:             timestamp('updated_at').notNull().defaultNow(),
}, (t) => ({
  emailIdx:         index('leads_email_idx').on(t.email),
  websiteIdx:       index('leads_website_idx').on(t.websiteUrl),
  scoreStatusIdx:   index('leads_quality_score_status_idx').on(t.leadQualityScore, t.status),
  websiteUniq:      uniqueIndex('leads_website_uniq').on(t.websiteUrl).where(sql`website_url IS NOT NULL`),
}));

export const leadCampaigns = pgTable('lead_campaigns', {
  id:                 uuid('id').primaryKey().defaultRandom(),
  leadId:             uuid('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  insightId:          uuid('insight_id').references(() => insights.id, { onDelete: 'set null' }),
  campaignType:       text('campaign_type').notNull(),
  subject:            text('subject').notNull(),
  body:               text('body').notNull(),
  status:             text('status').notNull().default('draft'),
  humanReviewItemId:  uuid('human_review_item_id').references(() => humanReviewItems.id, { onDelete: 'set null' }),
  resendMessageId:    text('resend_message_id'),
  sentAt:             timestamp('sent_at'),
  openedAt:           timestamp('opened_at'),
  clickedAt:          timestamp('clicked_at'),
  repliedAt:          timestamp('replied_at'),
  bouncedAt:          timestamp('bounced_at'),
  bounceReason:       text('bounce_reason'),
  replySentiment:     text('reply_sentiment'),
  replyBody:          text('reply_body'),
  createdAt:          timestamp('created_at').notNull().defaultNow(),
}, (t) => ({
  leadStatusIdx: index('lead_campaigns_lead_status_idx').on(t.leadId, t.status),
  resendIdx:     index('lead_campaigns_resend_idx').on(t.resendMessageId),
}));

export const leadBriefings = pgTable('lead_briefings', {
  id:           uuid('id').primaryKey().defaultRandom(),
  leadId:       uuid('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  title:        text('title').notNull(),
  htmlContent:  text('html_content').notNull(),
  evidenceData: jsonb('evidence_data'),
  generatedAt:  timestamp('generated_at').notNull().defaultNow(),
}, (t) => ({
  leadUniq: uniqueIndex('lead_briefings_lead_uniq').on(t.leadId),
}));

export const leadPipeline = pgTable('lead_pipeline', {
  id:                  uuid('id').primaryKey().defaultRandom(),
  leadId:              uuid('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  stage:               pipelineStageEnum('stage').notNull().default('prospecting'),
  estimatedValue:      real('estimated_value'),
  probabilityPercent:  integer('probability_percent'),
  expectedCloseDate:   timestamp('expected_close_date'),
  movedAt:             timestamp('moved_at').notNull().defaultNow(),
}, (t) => ({
  leadUniq: uniqueIndex('lead_pipeline_lead_uniq').on(t.leadId),
}));

export const crawlJobs = pgTable('crawl_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  crawlerType: text('crawler_type').notNull(),
  status: crawlStatusEnum('status').notNull().default('pending'),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  recordsFound: integer('records_found'),
  errorLog: text('error_log'),
  pagesCrawled: integer('pages_crawled'),
  durationMs: integer('duration_ms'),
  lastFreshAt: timestamp('last_fresh_at'),
  errorDetails: jsonb('error_details'),
}, (t) => ({ idx: index('crawl_jobs_type_status_idx').on(t.crawlerType, t.status) }));

// Phase 2 Tables
export const trends = pgTable('trends', {
  id: uuid('id').primaryKey().defaultRandom(),
  category: text('category').notNull(),
  countryCode: text('country_code').notNull(),
  growthRate: real('growth_rate').notNull(),
  /**
   * Six-tier opportunity classification from StatisticalTrendDetectionAgent.
   * Values: 'breakthrough' | 'accelerating' | 'sustained' | 'mature' | 'disrupted' | 'watch'
   * Nullable for rows created before the tier taxonomy was introduced.
   */
  opportunityTier: text('opportunity_tier'),
  periodStart: timestamp('period_start').notNull(),
  periodEnd: timestamp('period_end').notNull(),
  confidence: real('confidence').notNull(),
  signalIds: uuid('signal_ids').array(),
  detectionMethods: text('detection_methods').array(),
  isAccelerating: boolean('is_accelerating').notNull().default(false),
  volatilityIndex: real('volatility_index'),
  metadata: jsonb('metadata'),
  status: text('status').notNull().default('detected'),
  publishedAt: timestamp('published_at'),
  publicationMethod: text('publication_method'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => ({
  countryGrowthIdx: index('trends_country_category_growth_idx').on(t.countryCode, t.category, t.growthRate),
  tierIdx:          index('trends_tier_idx').on(t.opportunityTier),
}));

export const humanReviewItems = pgTable('human_review_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: text('type').notNull(),
  priority: integer('priority').notNull().default(5),
  data: jsonb('data').notNull(),
  validationResult: jsonb('validation_result'),
  reviewPrompt: text('review_prompt'),
  status: text('status').notNull().default('pending'),
  reviewedBy: text('reviewed_by'),
  reviewedAt: timestamp('reviewed_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (t) => ({ idx: index('human_review_status_priority_idx').on(t.status, t.priority) }));

export const agentOutputs = pgTable('agent_outputs', {
  id: uuid('id').primaryKey().defaultRandom(),
  agentType: text('agent_type').notNull(),
  outputData: jsonb('output_data').notNull(),
  relatedEntityIds: uuid('related_entity_ids').array(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Phase 2 — Gap & Retailer Intelligence Tables
// ---------------------------------------------------------------------------

/**
 * Cached external trade flow data (Comtrade / Eurostat).
 * TTL: 30 days — refreshed by DemandSupplyGapAgent before each scoring run.
 */
export const tradeFlowData = pgTable('trade_flow_data', {
  id: uuid('id').primaryKey().defaultRandom(),
  countryCode: text('country_code').notNull(),
  category: text('category').notNull(),
  periodYear: integer('period_year').notNull(),
  usImportsEurMillions: real('us_imports_eur_millions'),
  totalImportsEurMillions: real('total_imports_eur_millions'),
  /** Ratio of US imports to total world imports for this category/country (0–1). */
  importReliance: real('import_reliance').notNull(),
  /** Data source used: 'comtrade' | 'eurostat' | 'fallback' */
  source: text('source').notNull(),
  fetchedAt: timestamp('fetched_at').notNull().defaultNow(),
}, (t) => ({
  idx: index('trade_flow_country_category_year_idx').on(t.countryCode, t.category, t.periodYear),
}));

/**
 * Percentile-normalised gap scores produced by DemandSupplyGapAgent.
 * gap_score = 100 × (0.40×demand_pct + 0.35×import_pct + 0.25×(1−density_pct))
 */
export const gapScores = pgTable('gap_scores', {
  id: uuid('id').primaryKey().defaultRandom(),
  category: text('category').notNull(),
  countryCode: text('country_code').notNull(),
  trendId: uuid('trend_id').references(() => trends.id, { onDelete: 'set null' }),
  // Raw component values (before percentile ranking)
  demandSignal: real('demand_signal').notNull(),
  importReliance: real('import_reliance').notNull(),
  localBrandDensity: real('local_brand_density').notNull(),
  // Percentile-ranked components (0–1)
  demandPercentile: real('demand_percentile').notNull(),
  importPercentile: real('import_percentile').notNull(),
  /** Higher density_percentile = more crowded market (lowers gap score via inverse). */
  densityPercentile: real('density_percentile').notNull(),
  /** Final gap score 0–100. Higher = larger uncaptured opportunity. */
  gapScore: real('gap_score').notNull(),
  scoringFactors: jsonb('scoring_factors'),
  generatedAt: timestamp('generated_at').notNull().defaultNow(),
}, (t) => ({
  scoreIdx: index('gap_scores_score_idx').on(t.gapScore, t.generatedAt),
  countryIdx: index('gap_scores_country_category_idx').on(t.countryCode, t.category),
}));

/**
 * Pattern insights produced by RetailerBehaviorAgent.
 * patternType: 'expansion' | 'rotation' | 'us_brand_entry'
 */
export const retailerInsights = pgTable('retailer_insights', {
  id: uuid('id').primaryKey().defaultRandom(),
  category: text('category').notNull(),
  countryCode: text('country_code').notNull(),
  /** 'expansion' | 'rotation' | 'us_brand_entry' */
  patternType: text('pattern_type').notNull(),
  /** Number of distinct retailers contributing to the detected pattern. */
  retailerCount: integer('retailer_count').notNull(),
  /** IDs of retailer_activities rows that are evidence for this insight. */
  evidenceIds: uuid('evidence_ids').array(),
  /** Rule-based confidence 0–1. */
  confidence: real('confidence').notNull(),
  /** Raw structured output from the rule engine (counts, dates, retailer names). */
  ruleDetails: jsonb('rule_details').notNull(),
  /** Natural-language synthesis from DeepSeek (nullable — skipped if API unavailable). */
  aiSynthesis: text('ai_synthesis'),
  detectedAt: timestamp('detected_at').notNull().defaultNow(),
}, (t) => ({
  patternIdx: index('retailer_insights_pattern_idx').on(t.patternType, t.countryCode, t.detectedAt),
}));

// ---------------------------------------------------------------------------
// Phase 2 — Trade Flow Intelligence Table
// ---------------------------------------------------------------------------

/**
 * Strategic US↔EU trade flow intelligence collected by TradeFlowIntelligenceAgent.
 *
 * Flow types:
 *   'us_to_eu'  — US exports → each NCL EU market (primary demand signal)
 *   'eu_to_us'  — EU exports → US (competitive pressure / market saturation signal)
 *   'us_to_uk'  — US exports → UK (triangular routing leg 1, post-Brexit)
 *   'uk_to_eu'  — UK re-exports → EU (triangular routing leg 2, NI value prop signal)
 *
 * Historical depth: 2019–2023 (COVID baseline + Brexit structural changes).
 * Permanent cache for 2019-2022; 30-day TTL for 2023.
 */
export const tradeFlowIntelligence = pgTable('trade_flow_intelligence', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** 'us_to_eu' | 'eu_to_us' | 'us_to_uk' | 'uk_to_eu' */
  flowType: text('flow_type').notNull(),
  /** ISO-2 country recording the trade (or 'EUROSTAT' for EU-aggregate rows) */
  reporterCountry: text('reporter_country').notNull(),
  /** ISO-2 partner country (or 'EU27' for Eurostat aggregate rows) */
  partnerCountry: text('partner_country').notNull(),
  /** NCL strategic category: food_beverage | toys_games | cosmetics_personal_care | home_goods | supplements */
  nclCategory: text('ncl_category').notNull(),
  /** HS 2-digit chapter (e.g. '33') — '2106' used for supplement subheading within ch21 */
  hsChapter: text('hs_chapter').notNull(),
  year: integer('year').notNull(),
  /** USD trade value (Comtrade units) */
  tradeValueUsd: real('trade_value_usd'),
  /** Net weight in kilograms */
  netWeightKg: real('net_weight_kg'),
  /** Derived: tradeValueUsd / netWeightKg — proxy for product premiumness / margin potential */
  unitValueUsdPerKg: real('unit_value_usd_per_kg'),
  /** Year-over-year growth rate in percent (null for 2019 or when prior-year data unavailable) */
  growthRateYoy: real('growth_rate_yoy'),
  /** 'comtrade' | 'eurostat' */
  source: text('source').notNull(),
  fetchedAt: timestamp('fetched_at').notNull().defaultNow(),
}, (t) => ({
  /** Unique constraint enables upsert on conflict */
  uniqueFlowIdx: uniqueIndex('tfi_unique_flow_idx').on(
    t.flowType, t.reporterCountry, t.partnerCountry, t.nclCategory, t.hsChapter, t.year,
  ),
  categoryYearIdx: index('tfi_category_year_idx').on(t.nclCategory, t.year),
  countryFlowIdx: index('tfi_country_flow_idx').on(t.reporterCountry, t.partnerCountry, t.flowType),
}));

// ---------------------------------------------------------------------------
// Phase 2 — Monthly Trade Flow Table (for 6m / 12m rolling averages)
// ---------------------------------------------------------------------------

/**
 * Monthly US↔EU trade data sourced from Comtrade+ (freqCode=M).
 * Covers Jan 2022 – Dec 2023 for us_to_eu primary flows.
 * Enables genuine 6-month and 12-month rolling average computations in
 * TradeFlowAnalyticsEngine — distinct from the annual tradeFlowIntelligence table.
 */
export const tradeFlowMonthly = pgTable('trade_flow_monthly', {
  id: uuid('id').primaryKey().defaultRandom(),
  flowType: text('flow_type').notNull(),
  reporterCountry: text('reporter_country').notNull(),
  partnerCountry: text('partner_country').notNull(),
  nclCategory: text('ncl_category').notNull(),
  hsChapter: text('hs_chapter').notNull(),
  /** YYYYMM integer — e.g. 202301 for January 2023 */
  yearMonth: integer('year_month').notNull(),
  tradeValueUsd: real('trade_value_usd'),
  netWeightKg: real('net_weight_kg'),
  source: text('source').notNull().default('comtrade'),
  fetchedAt: timestamp('fetched_at').notNull().defaultNow(),
}, (t) => ({
  uniqueMonthlyIdx: uniqueIndex('tfm_unique_idx').on(
    t.flowType, t.reporterCountry, t.partnerCountry, t.nclCategory, t.hsChapter, t.yearMonth,
  ),
  monthlyYearMonthIdx: index('tfm_year_month_idx').on(t.yearMonth),
  monthlyCategoryIdx: index('tfm_category_idx').on(t.nclCategory, t.yearMonth),
}));

// ---------------------------------------------------------------------------
// Phase 2 — Competitor Market Share + Multi-layer Analytics Tables
// ---------------------------------------------------------------------------

/**
 * Raw EU-country-perspective import values per HS chapter, year and partner.
 * Collected by TradeFlowAnalyticsEngine (EU country as Comtrade reporter).
 * partnerCountry: 'WORLD' | 'US' | 'CN' | 'GB'
 * marketSharePct = importValueUsd / WORLD_importValueUsd × 100 (computed in-memory)
 */
export const competitorMarketShare = pgTable('competitor_market_share', {
  id: uuid('id').primaryKey().defaultRandom(),
  euCountry: text('eu_country').notNull(),
  hsChapter: text('hs_chapter').notNull(),
  nclCategory: text('ncl_category').notNull(),
  year: integer('year').notNull(),
  partnerCountry: text('partner_country').notNull(),
  importValueUsd: real('import_value_usd'),
  /** (importValueUsd / WORLD row) × 100 — null for WORLD rows themselves */
  marketSharePct: real('market_share_pct'),
  fetchedAt: timestamp('fetched_at').notNull().defaultNow(),
}, (t) => ({
  uniqueShareIdx: uniqueIndex('cms_unique_idx').on(t.euCountry, t.hsChapter, t.year, t.partnerCountry),
  countryYearIdx: index('cms_country_year_idx').on(t.euCountry, t.year),
}));

/**
 * Multi-layered analytics computed by TradeFlowAnalyticsEngine over the
 * tradeFlowIntelligence series.  One row per (flowType, reporter, partner,
 * category, chapter) reflecting the state as of the latest available year.
 *
 * Statistical layers:
 *   1. YoY growth              – single-year momentum
 *   2. 3-year CAGR             – smoothed mid-term trend
 *   3. 5-year CAGR             – long-term baseline
 *   4. Acceleration score      – (shortTermMomentum − cagr5yr) / |cagr5yr|
 *   5. OLS linear regression   – slope + R² on 5-point series
 *   6. Breakpoint detection    – 1H vs 2H normalised slope shift >50%
 *   7. Competitor market share – US / CN / GB share of total EU imports
 *   8. Saturation signal       – US growth vs total market growth ratio
 */
export const tradeFlowAnalytics = pgTable('trade_flow_analytics', {
  id: uuid('id').primaryKey().defaultRandom(),
  flowType: text('flow_type').notNull(),
  reporterCountry: text('reporter_country').notNull(),
  partnerCountry: text('partner_country').notNull(),
  nclCategory: text('ncl_category').notNull(),
  hsChapter: text('hs_chapter').notNull(),
  asOfYear: integer('as_of_year').notNull(),
  // ── Growth metrics ────────────────────────────────────────────────────────
  yoyGrowthPct: real('yoy_growth_pct'),
  cagr3yr: real('cagr_3yr'),
  cagr5yr: real('cagr_5yr'),
  // ── Momentum / acceleration ───────────────────────────────────────────────
  shortTermMomentum: real('short_term_momentum'),
  accelerationScore: real('acceleration_score'),
  isAccelerating: boolean('is_accelerating').notNull().default(false),
  // ── OLS regression ────────────────────────────────────────────────────────
  linearTrendSlope: real('linear_trend_slope'),
  rSquared: real('r_squared'),
  // ── Breakpoint detection ──────────────────────────────────────────────────
  breakpointDetected: boolean('breakpoint_detected').notNull().default(false),
  breakpointYear: integer('breakpoint_year'),
  /** 'acceleration' | 'deceleration' | 'reversal' */
  breakpointType: text('breakpoint_type'),
  firstHalfSlope: real('first_half_slope'),
  secondHalfSlope: real('second_half_slope'),
  // ── Rolling averages (from monthly Comtrade data) ────────────────────────
  /** 6-month rolling average trade value USD (latest window ending Dec 2023) */
  avg6mUsd: real('avg_6m_usd'),
  /** 12-month rolling average trade value USD */
  avg12mUsd: real('avg_12m_usd'),
  // ── US market share vs competitors (us_to_eu rows only) ──────────────────
  usMarketSharePct: real('us_market_share_pct'),
  usMarketSharePriorPct: real('us_market_share_prior_pct'),
  shareChangePct: real('share_change_pct'),
  /** 'gaining' | 'losing' | 'stable' */
  shareTrend: text('share_trend'),
  chinaMarketSharePct: real('china_market_share_pct'),
  ukMarketSharePct: real('uk_market_share_pct'),
  /** Rest-of-world share: (World − US − CN − GB) / World × 100 */
  rowMarketSharePct: real('row_market_share_pct'),
  /** usMarketSharePct − chinaMarketSharePct */
  usVsChinaShareDiff: real('us_vs_china_share_diff'),
  // ── Saturation signal ─────────────────────────────────────────────────────
  usGrowthVsMarketRatio: real('us_growth_vs_market_ratio'),
  /** 0–100; higher = higher saturation / ceiling risk */
  saturationRiskScore: real('saturation_risk_score'),
  // ── Eurostat consumption cross-reference (best-effort) ───────────────────
  /** EU domestic household consumption EUR millions (Eurostat nama_10_fcs) */
  euConsumptionEurM: real('eu_consumption_eur_m'),
  /** imports as % of domestic consumption — proxy for import dependency */
  importIntensityPct: real('import_intensity_pct'),
  /** YoY growth of EU domestic consumption (for saturation context) */
  consumptionGrowthPct: real('consumption_growth_pct'),
  // ── Monthly OLS (24-month series, Jan 2022 – Dec 2023) ───────────────────
  /** OLS slope from 24-point monthly series (USD/month, month index 0–23) */
  monthlyOlsSlope: real('monthly_ols_slope'),
  /** R² of the 24-month monthly OLS fit */
  monthlyOlsRSquared: real('monthly_ols_r_squared'),
  // ── Sliding breakpoint scan (best-fit breakpoint, not hardcoded 2021) ────
  /** YYYYMM of best monthly breakpoint — most extreme slope divergence in 24m series */
  monthlyBreakpointMonth: integer('monthly_breakpoint_month'),
  // ── Oversupply saturation signal ──────────────────────────────────────────
  /**
   * US import YoY growth minus EU domestic consumption growth (percentage points).
   * Positive value: imports growing faster than domestic demand — saturation risk.
   * Null when consumptionGrowthPct is unavailable (Eurostat best-effort).
   */
  importVsConsumptionGrowthGap: real('import_vs_consumption_growth_gap'),
  /**
   * True when importVsConsumptionGrowthGap > 10pp — imports materially outpacing
   * domestic consumption growth, flagging potential oversupply build-up.
   */
  oversupplySaturationFlag: boolean('oversupply_saturation_flag').notNull().default(false),
  computedAt: timestamp('computed_at').notNull().defaultNow(),
}, (t) => ({
  uniqueAnalyticsIdx: uniqueIndex('tfa_unique_idx').on(
    t.flowType, t.reporterCountry, t.partnerCountry, t.nclCategory, t.hsChapter, t.asOfYear,
  ),
  acceleratingIdx: index('tfa_accelerating_idx').on(t.isAccelerating, t.accelerationScore),
  shareIdx: index('tfa_share_idx').on(t.partnerCountry, t.nclCategory, t.asOfYear),
}));

// ---------------------------------------------------------------------------
// Phase 3 — NI Routing Intelligence
// ---------------------------------------------------------------------------

/**
 * Individual NI routing signal detections, produced by NIRoutingAgent.
 *
 * signalType values:
 *   'irish_sea_routing'   — us_to_uk growth outpacing direct us_to_eu, activating
 *                           the NI gateway corridor (proxy for IE surge vs GB flat)
 *   'uk_reexport_arb'     — uk_to_eu re-export volume/growth significant enough to
 *                           legitimise via Windsor Framework structuring
 *   'air_freight_suitable'— high unit value (USD/kg) makes NI air express routing
 *                           competitive with Rotterdam/Hamburg sea freight
 *   'distributor_gap'     — strong US-to-EU growth with sparse distributor coverage,
 *                           flagging NCL corridor-broker opportunity
 */
export const niRoutingSignals = pgTable('ni_routing_signals', {
  id: uuid('id').primaryKey().defaultRandom(),
  nclCategory: text('ncl_category').notNull(),
  hsChapter: text('hs_chapter'),
  /** Target EU market for this signal (ISO-2). 'ALL' for category-wide signals (e.g. air freight). */
  euCountry: text('eu_country').notNull(),
  /** 'irish_sea_routing' | 'uk_reexport_arb' | 'air_freight_suitable' | 'distributor_gap' */
  signalType: text('signal_type').notNull(),
  /** Normalised signal strength 0–1. */
  signalStrength: real('signal_strength').notNull(),
  /**
   * Which NI suitability sub-dimension this signal feeds (from scoring-weights.json):
   *   'vat_advantage'          → vatAdvantagePotential (weight 0.40)
   *   'distribution_efficiency'→ distributionEfficiencyGains (weight 0.30)
   *   'regulatory_clarity'     → regulatoryPathwayClarity (weight 0.30)
   */
  niSubDimension: text('ni_sub_dimension').notNull(),
  /** Raw evidence used to compute the signal (growth rates, values, counts). */
  evidence: jsonb('evidence').notNull(),
  computedAt: timestamp('computed_at').notNull().defaultNow(),
}, (t) => ({
  categoryCountryIdx: index('ni_signals_category_country_idx').on(t.nclCategory, t.euCountry),
  signalTypeIdx: index('ni_signals_type_idx').on(t.signalType, t.signalStrength),
  computedAtIdx: index('ni_signals_computed_at_idx').on(t.computedAt),
}));

// ---------------------------------------------------------------------------
// Phase 2 — Cross-Signal Correlation Intelligence
// ---------------------------------------------------------------------------

/**
 * Compound intelligence bundles produced by CrossSignalCorrelationAgent.
 *
 * Each row represents one (category, countryCode) corridor with three
 * evidence arrays:
 *   retailerLeadLag       — timing relationship between EU retailer listing surges
 *                           and US trade flow spikes (leading vs lagging indicator)
 *   tradeShowTargets      — upcoming trade shows cross-referenced against
 *                           accelerating HS categories for brand intercept windows
 *   distributorCoverageGap — distributor density vs trade flow growth, exposing
 *                           underserved corridors where NCL broker relationships
 *                           fill critical infrastructure gaps
 *
 * compoundSignals is a text array of human-readable intelligence statements
 * consumed directly by InsightGenerationAgent narrative prompts.
 */
export const opportunityCorrelations = pgTable('opportunity_correlations', {
  id:                        uuid('id').primaryKey().defaultRandom(),
  category:                  text('category').notNull(),
  countryCode:               text('country_code').notNull(),
  opportunityTier:           text('opportunity_tier'),
  compositeCorrelationScore: real('composite_correlation_score').notNull().default(0),
  retailerLeadLag:           jsonb('retailer_lead_lag'),
  tradeShowTargets:          jsonb('trade_show_targets').notNull().default(sql`'[]'::jsonb`),
  distributorCoverageGap:    jsonb('distributor_coverage_gap'),
  compoundSignals:           text('compound_signals').array().notNull().default(sql`'{}'::text[]`),
  computedAt:                timestamp('computed_at').notNull().defaultNow(),
}, (t) => ({
  categoryCountryIdx: index('opp_corr_category_country_idx').on(t.category, t.countryCode),
  scoreIdx:           index('opp_corr_score_idx').on(t.compositeCorrelationScore),
  tierIdx:            index('opp_corr_tier_idx').on(t.opportunityTier),
  categoryCountryUniq: uniqueIndex('opp_corr_category_country_uniq').on(t.category, t.countryCode),
}));

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
  playbooks:  many(tradeShowPlaybooks),
}));
export const tradeShowExhibitorsRelations = relations(tradeShowExhibitors, ({ one }) => ({
  tradeShow: one(tradeShows, { fields: [tradeShowExhibitors.tradeShowId], references: [tradeShows.id] }),
}));
export const tradeShowPlaybooksRelations = relations(tradeShowPlaybooks, ({ one }) => ({
  tradeShow: one(tradeShows, { fields: [tradeShowPlaybooks.tradeShowId], references: [tradeShows.id] }),
}));
export const opportunityScoresRelations = relations(opportunityScores, ({ one }) => ({
  brand: one(brands, { fields: [opportunityScores.brandId], references: [brands.id] }),
}));
export const outreachCampaignsRelations = relations(outreachCampaigns, ({ one }) => ({
  brand: one(brands, { fields: [outreachCampaigns.brandId], references: [brands.id] }),
  insight: one(insights, { fields: [outreachCampaigns.insightId], references: [insights.id] }),
}));
export const leadsRelations = relations(leads, ({ one, many }) => ({
  brand: one(brands, { fields: [leads.brandId], references: [brands.id] }),
  campaigns: many(leadCampaigns),
  briefing: one(leadBriefings, { fields: [leads.id], references: [leadBriefings.leadId] }),
  pipeline: one(leadPipeline, { fields: [leads.id], references: [leadPipeline.leadId] }),
}));
export const leadCampaignsRelations = relations(leadCampaigns, ({ one }) => ({
  lead: one(leads, { fields: [leadCampaigns.leadId], references: [leads.id] }),
  insight: one(insights, { fields: [leadCampaigns.insightId], references: [insights.id] }),
}));
export const leadBriefingsRelations = relations(leadBriefings, ({ one }) => ({
  lead: one(leads, { fields: [leadBriefings.leadId], references: [leads.id] }),
}));
export const leadPipelineRelations = relations(leadPipeline, ({ one }) => ({
  lead: one(leads, { fields: [leadPipeline.leadId], references: [leads.id] }),
}));
