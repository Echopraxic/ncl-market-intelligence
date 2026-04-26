# NCL Market Intelligence Engine

## Project Purpose
Automated EU market opportunity discovery system for North Channel Logistics (NCL).
Identifies US consumer brands with high potential for EU expansion via Northern Ireland (NI) routing.

## Business Objective
Transform NCL from a reactive consultancy into a proactive opportunity platform.
The system discovers EU expansion opportunities before brands realise they exist,
delivering data-backed strategies and pre-packaged solutions.

## The Four Strategic Questions
1. What product categories are growing in specific EU markets?
2. Which US brands are best positioned to capitalise on that growth?
3. Where are EU buyers (distributors, retailers) actively sourcing new products?
4. Where are deals forming (trade shows, marketplaces, networks)?

## Core Pipeline
Data Ingestion → Normalization → Signal Extraction → Scoring → Insight Generation → Action Triggers

## Tech Stack
- Runtime: Node.js 20 LTS (TypeScript, ESM)
- Database: PostgreSQL 16 + pgvector (via Docker: pgvector/pgvector:pg16)
- Queue: Redis 7 + BullMQ
- ORM: Drizzle ORM (schema: apps/api/src/db/schema.ts)
- API: Fastify 5 (apps/api/src/api/server.ts)
- AI: DeepSeek API (DEEPSEEK_API_KEY in apps/api/.env)
- Frontend: Next.js 14 + Tailwind CSS (apps/dashboard)
- Email: Resend
- Package Manager: npm workspaces (monorepo)

## Monorepo Structure
```
apps/api        — Fastify API, BullMQ workers, all agents
apps/dashboard  — Next.js 14 internal-only dashboard (no auth yet)
packages/shared — Shared TypeScript types
```

## Automation Policy
The system operates autonomously by default. Human sign-off is required **only** for:
- Sending outreach emails to external humans (brands, distributors, trade contacts)
- Any communication that goes outside the system to a real person

Everything else — crawling, scoring, insight generation, internal reporting, trend detection,
gap analysis, scheduler configuration, threshold tuning — runs automatically without approval.
The `humanReviewItems` table exists for workflow management, not as a gate on internal operations.

## Development Phases

| Phase | Scope | Status |
|-------|-------|--------|
| 1 — Foundation | DB schema, crawlers, API server, dashboard skeleton, normalization agents | **Complete** |
| 2 — Intelligence | Trade flow agents, gap scoring, retailer agent, trend detection | **Complete** |
| 3 — Scoring & Insights | Composite scoring engine, insight generation agent, brand fit scoring, trade show playbooks | **Complete** |
| 4 — Lead Generation | Lead discovery scrapers, scoring, pitch angles, outreach, engagement, CRM export | **In progress** |

## Macro To-Do: Full Functionality Checklist

The system fully answers the four strategic questions when all items below are done.

### Phase 2 Completion (Intelligence layer) — ALL COMPLETE
- [x] Complete `StatisticalTrendEngine` helper method stubs — done; six-tier taxonomy implemented
- [x] Add API endpoints: `POST /api/agents/trends/run`, `GET /api/human-review`, `PATCH /api/human-review/:id`
- [x] Dashboard: Trends page (list detected trends, confidence, validation status, approve/reject)
- [x] Dashboard: Gap Scores leaderboard (category × country ranked by gap score)
- [x] Dashboard: Retailer Insights page (by country, pattern type, confidence)
- [x] Dashboard: Trade Analytics page (acceleration view, competitor share, saturation risk)
- [x] Dashboard: Human Review Queue (approve/reject interface feeding back into pipeline)
- [x] Wire `TrendScheduler.notifyDownstreamSystems()` to trigger gap scoring + downstream agents
- [x] Wire CrossSignalCorrelationAgent into TrendScheduler downstream chain (runs after gap + retailer agents)

### Phase 3 — Scoring & Insights
- [x] **Composite Scoring Agent**: combine gap score + trade flow momentum + retailer signals into `opportunityScores` table
  - Formula: `(CategoryScore × 0.40) + (BrandScore × 0.35) + (NIScore × 0.25)`
  - Inputs: `gapScores`, `tradeFlowIntelligence` (unitValue), `niRoutingSignals`, `retailerInsights`, `trends`
  - Corridor-level only (brandId = null); upserts on unique (category, country_code)
  - Runs automatically as final step of TrendScheduler downstream chain
- [x] **Brand Fit Scoring + NI Suitability Scoring**: `BrandFitScoringAgent` scores every brand against every active corridor
  - Brand Fit factors: category alias match (1.0 exact / 0.7 substring), revenue tier (micro 0.3 / small 0.7 / mid 1.0 / large 0.5), Shopify signal; EU presence multiplier 0.6
  - NI Suitability factors: avg NI signal strength (from niRoutingSignals), US-only distribution (1.0 if no EU presence), brand size fit
  - Output: one `opportunityScores` row per (brandId, category, countryCode); partial unique index `opp_scores_brand_category_country_uniq`
  - Runs automatically as Step D of TrendScheduler downstream chain (after CompositeScoringAgent); also `POST /api/agents/brand-fit/run`
- [x] **Insight Generation Agent**: synthesise scores + signals into natural-language insights (`insights` table)
  - Insight types: `opportunity_alert`, `market_brief`, `trade_show_playbook`, `weekly_report`
  - Rule-based structured context + DeepSeek narrative paragraph; template fallback if API unavailable
  - Deduplication: 7-day title-based cooldown per corridor/brand/show; weekly_report max once per ISO week
  - Runs automatically as Step E of TrendScheduler chain (after BrandFitScoringAgent); also `POST /api/agents/insights/run`
- [x] **Trade Show Playbook Generator**: per-show synthesis of exhibitors + brands + gap scores + trends → actionable narrative
  - Exhibitor×Brand matching: case-insensitive name lookup into brands DB; pulls composite scores, revenue tier, EU presence, Shopify signal
  - Per-exhibitor prospect cards with rule-based pitch angles (priority intercept / high-value / qualified lead / watch)
  - Distributor coverage map per (category, countryCode) corridor: PostgreSQL `@>` array containment query; flags gaps (≤1 distributor)
  - Structured output persisted to dedicated `trade_show_playbooks` table (upserted per show); DeepSeek 500–700w narrative + template fallback
  - Standalone trigger: `POST /api/agents/trade-show-playbook/run`; not in TrendScheduler chain
- [x] Dashboard: Opportunity Leaderboard (composite score ranked, filterable by category/country)
  - `/opportunities` — corridor tab + brand tab (URL param `?view=brands`), filters for category/country/minComposite, trigger buttons for both scoring agents
- [x] Dashboard: Insights feed (generated insight cards with evidence trail)
  - `/insights-feed` — card feed with type/status filters, body preview + evidence summary indicator

### Phase 4 — Lead Generation Engine (In Progress)
- [x] **Schema**: `leads`, `lead_campaigns`, `lead_briefings`, `lead_pipeline` tables + `lead_status`, `pipeline_stage` enums
- [x] **BaseLeadCrawler**: abstract extension of BaseCrawler; extension point for all future lead scrapers
- [x] **ProductHuntCrawler**: scrapes top D2C launches by NCL category from producthunt.com
- [x] **LinkedInCrawler**: public company pages of known brands — headcount + EU hiring signals
- [x] **CPGDirectoryCrawler**: cpgd.com + bevnet.com brand directories
- [x] **LeadDiscoveryAgent**: aggregates + deduplicates leads from all 3 scrapers + scored brands + trade show exhibitors
- [x] **LeadScoringAgent**: `leadQualityScore = compositeScore×0.40 + gapScore×0.25 + trendTierBonus×0.20 + contactCompleteness×0.15`
- [x] **PitchAngleAgent**: rule-based angle selection (first_mover/unmet_demand/cost_optimisation/margin_expansion) + DeepSeek expansion
- [x] **LeadOutreachAgent**: email gen + HTML briefing pack + `humanReviewItems` queue (type: `lead_outreach`)
- [x] **LeadEngagementAgent**: Resend webhook handler; classifies reply sentiment, advances pipeline stage
- [x] **CRMExportAgent**: weekly JSON export to `exports/crm-leads-<date>.json`; `crmExportedAt` tracking
- [x] **API endpoints**: `GET/PATCH /api/leads`, `GET /api/campaigns`, `POST /api/campaigns/:id/send`, `GET /api/lead-pipeline`, `POST /api/agents/lead-*/run`, `POST /api/webhooks/resend`
- [x] **Dashboard**: `/leads`, `/outreach-queue`, `/lead-pipeline` + nav links + homepage stats row
- [x] **Weekly Master Scheduler**: `MasterSchedulerAgent` orchestrates full pipeline — trade flow → analytics → NI routing → crawlers → trend scheduler → lead-gen chain → trigger rules; `POST /api/agents/master-scheduler/run`
- [x] **Real-time Alerts**: breakthrough-tier trends insert high-priority `humanReviewItems` rows (priority=10) in TrendScheduler step 5b
- [x] **Monthly/Quarterly Report Generator**: `ReportGeneratorAgent` writes weekly digest + monthly market brief to `insights` table; `POST /api/agents/report-generator/run`
- [x] **Trigger Rules Engine**: `TriggerRulesEngine` evaluates active `triggerRules` against `opportunity_scores`; fires alert insights + queues leads for outreach; `POST /api/agents/trigger-rules/run`
- [x] Dashboard: Reports page (`/reports`) — lists weekly digests and monthly briefs with trigger buttons

### Infrastructure
- [x] **Resolve Redis blocker**: Railway Redis 7 resolves the Windows dev blocker (local Redis 3.0.504 is dev-only). Production uses Railway Redis plugin which satisfies BullMQ's Redis 5+ requirement.
- [x] **Deploy to Railway**: `Dockerfile` (API) + `apps/dashboard/Dockerfile` (dashboard) + `railway.toml` per service. See `DEPLOY.md` for step-by-step guide.
  - API: builds from repo root, runs `runMigrations()` idempotently on startup before serving
  - Dashboard: Next.js standalone build, reads `API_URL` + `API_SECRET_KEY` env vars
  - DB: Railway Postgres plugin with pgvector extension; schema applied automatically
  - Redis: Railway Redis 7 plugin enables full BullMQ scheduler in production
- [x] **Production migration runner**: `apps/api/src/db/migrate.ts` — comprehensive idempotent DDL (all tables, indexes, enums, pgvector) runs on every startup via `runMigrations()` called from `index.ts`
- [x] **Health check with DB ping**: `/health` now verifies DB connectivity; returns 503 if DB unreachable so Railway can restart the container
- [x] **Scoring weights config**: `apps/api/src/config/scoring-weights.json` — exists with tier boundaries, aliases, trade show keywords

## Key Design Decisions
- NI Routing: Northern Ireland dual-market position is a core differentiator; NI Suitability is one of three scoring dimensions
- Composite Score: `(CategoryScore × 0.40) + (BrandScore × 0.35) + (NIScore × 0.25)`
- Email: Resend (not SendGrid)
- CRM: Lightweight custom layer (Phase 4); HubSpot integration optional later
- Deployment: Railway

## Opportunity Tier Taxonomy
| Tier | Growth Rate | Engagement Strategy |
|------|-------------|---------------------|
| breakthrough | >50% YoY | Immediate outreach + pitch generation (first-mover window) |
| accelerating | 25–50% | Competitive entry outreach (proven demand, brands scaling) |
| sustained | 10–25% | NI routing efficiency pitch (established market) |
| mature | 5–10% | Niche targeting or differentiation pitch |
| disrupted | <0% | Vacuum-fill opportunity (structural shifts: tariffs, supplier exits) |
| watch | volatile/noisy | Monitor only — no resource allocation until pattern clarifies |

## Scoring Thresholds
- Opportunity alert: composite_score > 80
- Lead generation: composite > 75 AND category > 70
- Auto-queue outreach: composite > 80 (still requires human approval to send)
- Human review queue: 70 ≤ composite ≤ 80
- Max outreach/day: 50 | Min gap between emails to same brand: 3 days

## Target EU Markets
DE (Germany), FR (France), NL (Netherlands), GB (United Kingdom), ES (Spain), IT (Italy)

## Commands
```
npm run dev:api          — Start API dev server (port 3001)
npm run dev:dashboard    — Start dashboard dev server (port 3000)
npm run db:push          — Push schema changes to DB (dev)
npm run db:generate      — Generate Drizzle migration files
npm run db:studio        — Open Drizzle Studio UI
docker-compose up postgres redis  — Start local DB + Redis
```

## Database Notes
- pgvector extension must be enabled before pushing schema
- Run in psql: `CREATE EXTENSION IF NOT EXISTS vector;`
- All tables in `apps/api/src/db/schema.ts`
- `description_embedding vector(1536)` on products table added via raw SQL after extension enabled
- Three analytics tables applied via script (not drizzle-kit) to avoid --force prompt interception:
  - `trade_flow_monthly`      — monthly Comtrade data (YYYYMM, Jan 2022–Dec 2023)
  - `competitor_market_share` — EU country imports from WORLD / US / CN / GB per HS chapter
  - `trade_flow_analytics`    — computed multi-layer analytics (OLS, CAGR, acceleration, shares)
- `opportunity_correlations` table is defined in Drizzle schema and pushed normally via `db:push`
  - Unique constraint on `(category, country_code)` — upserted on each agent run
- To apply analytics tables: `node --env-file=apps/api/.env scripts/apply-analytics-tables.mjs`
- drizzle-kit `db:push --force` is intercepted by npm; use the script above for analytics tables

## Agents Inventory

### Data Collection (Phase 1–2, Complete)
| Agent | File | Status |
|-------|------|--------|
| TradeFlowIntelligenceAgent | `apps/api/src/agents/signals/trade-flow-agent.ts` | Complete |
| TradeFlowAnalyticsEngine | `apps/api/src/agents/signals/trade-flow-analytics.ts` | Complete |
| CrawlerScheduler | `apps/api/src/agents/crawlers/scheduler.ts` | Complete (Redis-gated) |
| AmazonEUCrawler | `apps/api/src/agents/crawlers/amazon-eu-crawler.ts` | Complete |
| GoogleTrendsCrawler | `apps/api/src/agents/crawlers/google-trends-crawler.ts` | Complete |
| ShopifyBrandCrawler | `apps/api/src/agents/crawlers/shopify-brand-crawler.ts` | Complete |
| TradeShowCrawler | `apps/api/src/agents/crawlers/trade-show-crawler.ts` | Complete |

### Signal Processing (Phase 2, Mostly Complete)
| Agent | File | Status |
|-------|------|--------|
| DemandSupplyGapAgent | `apps/api/src/agents/signals/gap-agent.ts` | Complete |
| RetailerBehaviorAgent | `apps/api/src/agents/signals/retailer-agent.ts` | Complete |
| CrossSignalCorrelationAgent | `apps/api/src/agents/signals/cross-signal-correlation-agent.ts` | Complete |
| StatisticalTrendEngine | `apps/api/src/agents/signals/trend-detection/statistical-trend-engine.ts` | Complete |
| TrendValidator | `apps/api/src/agents/signals/trend-detection/trend-validator.ts` | Complete |
| TrendScheduler | `apps/api/src/agents/signals/trend-detection/trend-scheduler.ts` | Complete |
| RuleBasedStructuringAgent | `apps/api/src/agents/normalization/rule-based-structuring-agent.ts` | Complete |
| StructuringAgent (AI) | `apps/api/src/agents/normalization/structuring-agent.ts` | Complete |

### Phase 3 (In Progress)
| Agent | File | Status |
|-------|------|--------|
| CompositeScoringAgent | `apps/api/src/agents/signals/composite-scoring-agent.ts` | Complete |
| BrandFitScoringAgent | `apps/api/src/agents/signals/brand-fit-scoring-agent.ts` | Complete |
| InsightGenerationAgent | `apps/api/src/agents/signals/insight-generation-agent.ts` | Complete |
| TradeShowPlaybookAgent | `apps/api/src/agents/signals/trade-show-playbook-agent.ts` | Complete |

### Phase 4 — Lead Generation (In Progress)
| Agent | File | Status |
|-------|------|--------|
| BaseLeadCrawler | `apps/api/src/agents/crawlers/base-lead-crawler.ts` | Complete |
| ProductHuntCrawler | `apps/api/src/agents/crawlers/product-hunt-crawler.ts` | Complete |
| LinkedInCrawler | `apps/api/src/agents/crawlers/linkedin-crawler.ts` | Complete |
| CPGDirectoryCrawler | `apps/api/src/agents/crawlers/cpg-directory-crawler.ts` | Complete |
| LeadDiscoveryAgent | `apps/api/src/agents/lead-gen/lead-discovery-agent.ts` | Complete |
| LeadScoringAgent | `apps/api/src/agents/lead-gen/lead-scoring-agent.ts` | Complete |
| PitchAngleAgent | `apps/api/src/agents/lead-gen/pitch-angle-agent.ts` | Complete |
| LeadOutreachAgent | `apps/api/src/agents/lead-gen/lead-outreach-agent.ts` | Complete |
| LeadEngagementAgent | `apps/api/src/agents/lead-gen/lead-engagement-agent.ts` | Complete |
| CRMExportAgent | `apps/api/src/agents/lead-gen/crm-export-agent.ts` | Complete |

### Phase C — Orchestration & Reporting (Complete)
| Agent | File | Status |
|-------|------|--------|
| MasterSchedulerAgent | `apps/api/src/agents/master-scheduler.ts` | Complete |
| TriggerRulesEngine | `apps/api/src/agents/trigger-rules-engine.ts` | Complete |
| ReportGeneratorAgent | `apps/api/src/agents/signals/report-generator-agent.ts` | Complete |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Liveness check |
| GET | /api/brands | List brands (filterable) |
| GET | /api/signals | EU market signals |
| GET | /api/trends | Detected trends |
| GET | /api/gaps | Demand/supply gap scores |
| GET | /api/retailer-insights | Retailer behaviour patterns |
| GET | /api/trade-flows | Annual US↔EU trade intelligence |
| GET | /api/trade-analytics | Multi-layer analytics (OLS, CAGR, acceleration, shares) |
| GET | /api/trade-shows | Upcoming trade shows |
| GET | /api/crawl-jobs | Crawler job status |
| POST | /api/agents/trade-flow/run | Trigger TradeFlowIntelligenceAgent |
| POST | /api/agents/trade-analytics/run | Trigger TradeFlowAnalyticsEngine |
| POST | /api/agents/gap/run | Trigger DemandSupplyGapAgent |
| POST | /api/agents/retailer/run | Trigger RetailerBehaviorAgent |
| GET | /api/ni-routing-signals | NI routing intelligence signals |
| POST | /api/agents/ni-routing/run | Trigger NIRoutingAgent |
| GET | /api/opportunity-correlations | Cross-signal correlation bundles (lead-lag, trade shows, distributor gaps) |
| POST | /api/agents/correlation/run | Trigger CrossSignalCorrelationAgent |
| POST | /api/agents/trends/run | Trigger TrendDetectionScheduler |
| GET | /api/human-review | Human review queue (filterable by type/status) |
| PATCH | /api/human-review/:id | Approve or reject a review item |
| POST | /api/crawlers/:type/trigger | Trigger a specific crawler |

| GET | /api/opportunity-scores | Composite corridor scores (brandId=null, ordered by compositeScore desc) |
| POST | /api/agents/composite-scoring/run | Trigger CompositeScoringAgent |
| POST | /api/agents/brand-fit/run | Trigger BrandFitScoringAgent |
| GET | /api/insights | Generated insights (filterable by type/status) |
| POST | /api/agents/insights/run | Trigger InsightGenerationAgent |
| GET | /api/brand-scores | Brand opportunity scores with brand name, joined; filterable by category/country/minComposite |
| GET | /api/trade-show-playbooks | Structured trade show playbooks (filterable by status) |
| POST | /api/agents/trade-show-playbook/run | Trigger TradeShowPlaybookAgent |

*Endpoints to add: `/api/outreach`*

## Trade Data Sources
- **UN Comtrade+ public preview** (no auth): `https://comtradeapi.un.org/public/v1/preview/C/A/HS`
  - Annual: `/C/A/HS` | Monthly: `/C/M/HS`
  - Rate limit: ~1 req/sec on free tier; 429s handled gracefully
- **Eurostat COMEXT** DS-045409: EU-27 aggregate cross-validation (returns 404 intermittently)
- **Eurostat nama_10_fcs**: Household consumption by COICOP (best-effort, often 404)

## HS Chapter → NCL Category Mapping
| HS Chapters | NCL Category |
|-------------|--------------|
| 16–24 | food_beverage (ch21 subheading 2106 → supplements) |
| 30 | supplements |
| 33 | cosmetics_personal_care |
| 94 | home_goods |
| 95 | toys_games |
