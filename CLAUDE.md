# NCL Market Intelligence Engine

## Project Purpose
Automated EU market opportunity discovery system for North Channel Logistics (NCL).
Identifies US consumer brands with high potential for EU expansion via Northern Ireland (NI) routing,
and matches them with EU/UK distributors who are actively sourcing new products.

## Business Objective
Transform NCL from a reactive consultancy into a proactive opportunity platform.
The system discovers EU expansion opportunities before brands realise they exist,
delivering data-backed strategies and pre-packaged solutions. It also surfaces EU distributors
actively sourcing in high-growth categories — making NCL the broker between US supply and EU buyer demand.

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
| 3 — Scoring & Insights | Composite scoring engine, insight generation, brand fit scoring, trade show playbooks | **Complete** |
| 4 — Lead Generation | Lead discovery, scoring, pitch angles, outreach, engagement, CRM export | **Complete** |
| 5 — Distribution Intelligence | EU distributor network, buyer intent, brand–distributor matching, regulatory fit | **Complete** |
| 6 — Production Hardening | Auth, data seeding, playwright-extra install, schema auto-migration, monitoring | **Not started** |

---

## Agents Inventory

### Data Collection
| Agent | File | Status |
|-------|------|--------|
| TradeFlowIntelligenceAgent | `apps/api/src/agents/signals/trade-flow-agent.ts` | Complete |
| TradeFlowAnalyticsEngine | `apps/api/src/agents/signals/trade-flow-analytics.ts` | Complete |
| CrawlerScheduler | `apps/api/src/agents/crawlers/scheduler.ts` | Complete (Redis-gated) |
| AmazonEUCrawler | `apps/api/src/agents/crawlers/amazon-eu-crawler.ts` | Complete |
| GoogleTrendsCrawler | `apps/api/src/agents/crawlers/google-trends-crawler.ts` | Complete |
| ShopifyBrandCrawler | `apps/api/src/agents/crawlers/shopify-brand-crawler.ts` | Complete |
| TradeShowCrawler | `apps/api/src/agents/crawlers/trade-show-crawler.ts` | Complete |
| CPGDirectoryCrawler | `apps/api/src/agents/crawlers/cpg-directory-crawler.ts` | Complete |
| ProductHuntCrawler | `apps/api/src/agents/crawlers/product-hunt-crawler.ts` | Complete |
| LinkedInCrawler | `apps/api/src/agents/crawlers/linkedin-crawler.ts` | Complete |
| FaireCrawler | `apps/api/src/agents/crawlers/faire-crawler.ts` | Complete |
| ThingTestingCrawler | `apps/api/src/agents/crawlers/thingtesting-crawler.ts` | Complete |
| BulletinCrawler | `apps/api/src/agents/crawlers/bulletin-crawler.ts` | Complete |
| IndustryDirectoryCrawler | `apps/api/src/agents/crawlers/industry-directory-crawler.ts` | Complete (Europages + Kompass) |

### Signal Processing
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

### Scoring & Insights
| Agent | File | Status |
|-------|------|--------|
| CompositeScoringAgent | `apps/api/src/agents/signals/composite-scoring-agent.ts` | Complete |
| BrandFitScoringAgent | `apps/api/src/agents/signals/brand-fit-scoring-agent.ts` | Complete |
| InsightGenerationAgent | `apps/api/src/agents/signals/insight-generation-agent.ts` | Complete |
| TradeShowPlaybookAgent | `apps/api/src/agents/signals/trade-show-playbook-agent.ts` | Complete |
| NIRoutingAgent | `apps/api/src/agents/signals/ni-routing-agent.ts` | Complete |

### Lead Generation
| Agent | File | Status |
|-------|------|--------|
| BaseLeadCrawler | `apps/api/src/agents/crawlers/base-lead-crawler.ts` | Complete |
| LeadDiscoveryAgent | `apps/api/src/agents/lead-gen/lead-discovery-agent.ts` | Complete |
| LeadScoringAgent | `apps/api/src/agents/lead-gen/lead-scoring-agent.ts` | Complete |
| PitchAngleAgent | `apps/api/src/agents/lead-gen/pitch-angle-agent.ts` | Complete |
| LeadOutreachAgent | `apps/api/src/agents/lead-gen/lead-outreach-agent.ts` | Complete |
| LeadEngagementAgent | `apps/api/src/agents/lead-gen/lead-engagement-agent.ts` | Complete |
| CRMExportAgent | `apps/api/src/agents/lead-gen/crm-export-agent.ts` | Complete |

### Distribution Intelligence
| Agent | File | Status |
|-------|------|--------|
| DistributorDiscoveryAgent | `apps/api/src/agents/distributor/distributor-discovery-agent.ts` | Complete |
| BuyerIntentAgent | `apps/api/src/agents/distributor/buyer-intent-agent.ts` | Complete |
| DistributorScoringAgent | `apps/api/src/agents/distributor/distributor-scoring-agent.ts` | Complete |
| DistributorMatchingAgent | `apps/api/src/agents/distributor/distributor-matching-agent.ts` | Complete |
| RegulatoryFitAgent | `apps/api/src/agents/distributor/regulatory-fit-agent.ts` | Complete |
| CompetitorIntelligenceAgent | — | **Not implemented** (deferred indefinitely) |

### Orchestration & Reporting
| Agent | File | Status |
|-------|------|--------|
| MasterSchedulerAgent | `apps/api/src/agents/master-scheduler.ts` | Complete (23-step pipeline) |
| TriggerRulesEngine | `apps/api/src/agents/trigger-rules-engine.ts` | Complete |
| ReportGeneratorAgent | `apps/api/src/agents/signals/report-generator-agent.ts` | Complete |

---

## Master Scheduler Pipeline (23 Steps)

Triggered weekly via `POST /api/agents/master-scheduler/run` or cron.

| Step | Name | Agent |
|------|------|-------|
| 1 | trade-flow | TradeFlowIntelligenceAgent |
| 2 | trade-analytics | TradeFlowAnalyticsEngine |
| 3 | ni-routing | NIRoutingAgent |
| 4–11 | crawl-* (8 crawlers) | Shopify, Google Trends, Amazon EU, Trade Shows, CPG Directory, Faire, ThingTesting, Bulletin |
| 12 | trend-scheduler | TrendDetectionScheduler (internally: trend→gap→retailer→correlation→composite→brand-fit→insights) |
| 13 | lead-discovery | LeadDiscoveryAgent |
| 14 | lead-scoring | LeadScoringAgent |
| 15 | crawl-industry-directory | IndustryDirectoryCrawler |
| 16 | distributor-discovery | DistributorDiscoveryAgent |
| 17 | buyer-intent | BuyerIntentAgent |
| 18 | distributor-scoring | DistributorScoringAgent |
| 19 | regulatory-fit | RegulatoryFitAgent |
| 20 | pitch-angles | PitchAngleAgent |
| 21 | distributor-matching | DistributorMatchingAgent |
| 22 | crm-export | CRMExportAgent |
| 23 | trigger-rules | TriggerRulesEngine |

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Liveness + DB connectivity check (503 if DB down) |
| GET | /api/brands | List brands (filterable by EU presence, category) |
| GET | /api/brands/:id | Brand detail with scores, lead record, recent signals |
| GET | /api/brand-scores | Brand opportunity scores (joined with brand name) |
| GET | /api/signals | EU market signals (country/category/source/date filters) |
| GET | /api/trends | Detected trends (tier, growth rate, status filters) |
| GET | /api/gaps | Demand/supply gap scores |
| GET | /api/retailer-insights | Retailer behaviour patterns |
| GET | /api/trade-flows | Annual US↔EU trade intelligence |
| GET | /api/trade-analytics | Multi-layer analytics (OLS, CAGR, acceleration, shares) |
| GET | /api/ni-routing-signals | NI routing intelligence signals |
| GET | /api/opportunity-correlations | Cross-signal correlation bundles |
| GET | /api/opportunity-scores | Composite corridor scores (brandId=null) |
| GET | /api/insights | Generated insights (type/status filters) |
| GET | /api/trade-shows | Upcoming trade shows (optional exhibitor detail) |
| GET | /api/trade-show-playbooks | Structured playbooks per show |
| GET | /api/crawl-jobs | Crawler job history |
| GET | /api/human-review | Human review queue (type/status filters) |
| PATCH | /api/human-review/:id | Approve or reject a review item |
| GET | /api/leads | Lead discovery results (status/source/score/category filters) |
| GET | /api/leads/:id | Lead detail with campaigns and pipeline |
| PATCH | /api/leads/:id | Update lead status, assignment, notes |
| GET | /api/campaigns | Lead outreach campaigns |
| POST | /api/campaigns/:id/send | Send approved campaign via Resend |
| GET | /api/lead-pipeline | Pipeline stage summary with estimated values |
| GET | /api/distributors | EU distributor network (country/category/score filters) |
| GET | /api/buyer-intent | Distributor buying intent signals |
| GET | /api/distributor-matches | Brand–distributor match table |
| POST | /api/crawlers/:type/trigger | Trigger a specific crawler |
| POST | /api/agents/trade-flow/run | TradeFlowIntelligenceAgent |
| POST | /api/agents/trade-analytics/run | TradeFlowAnalyticsEngine |
| POST | /api/agents/ni-routing/run | NIRoutingAgent |
| POST | /api/agents/gap/run | DemandSupplyGapAgent |
| POST | /api/agents/retailer/run | RetailerBehaviorAgent |
| POST | /api/agents/correlation/run | CrossSignalCorrelationAgent |
| POST | /api/agents/trends/run | TrendDetectionScheduler (full chain) |
| POST | /api/agents/composite-scoring/run | CompositeScoringAgent |
| POST | /api/agents/brand-fit/run | BrandFitScoringAgent |
| POST | /api/agents/insights/run | InsightGenerationAgent |
| POST | /api/agents/trade-show-playbook/run | TradeShowPlaybookAgent |
| POST | /api/agents/lead-discovery/run | LeadDiscoveryAgent |
| POST | /api/agents/lead-scoring/run | LeadScoringAgent |
| POST | /api/agents/pitch-angles/run | PitchAngleAgent |
| POST | /api/agents/lead-outreach/run | LeadOutreachAgent |
| POST | /api/agents/crm-export/run | CRMExportAgent |
| POST | /api/agents/distributor-discovery/run | DistributorDiscoveryAgent |
| POST | /api/agents/buyer-intent/run | BuyerIntentAgent |
| POST | /api/agents/distributor-scoring/run | DistributorScoringAgent |
| POST | /api/agents/distributor-matching/run | DistributorMatchingAgent |
| POST | /api/agents/regulatory-fit/run | RegulatoryFitAgent |
| POST | /api/agents/report-generator/run | ReportGeneratorAgent |
| POST | /api/agents/trigger-rules/run | TriggerRulesEngine |
| POST | /api/agents/master-scheduler/run | Full 23-step pipeline |
| POST | /api/webhooks/resend | Resend email engagement events |

---

## Dashboard Pages (21 pages)

| Route | Description |
|-------|-------------|
| / | Overview with pipeline stats |
| /brands | Brand catalog with EU presence filter |
| /brands/[id] | Brand detail page |
| /signals | EU market signals feed |
| /trends | Trend detection results with tier badges |
| /gaps | Gap score leaderboard (category × country) |
| /retailer-insights | Retailer behaviour patterns |
| /trade-analytics | Trade flow acceleration + market share |
| /human-review | Approve/reject queue |
| /trade-shows | Upcoming shows inventory |
| /opportunities | Corridor + brand opportunity leaderboard |
| /insights-feed | Generated market briefs and alerts |
| /crawl-jobs | Crawler job history + live poller |
| /leads | Lead discovery results |
| /outreach-queue | Pending outreach campaigns |
| /lead-pipeline | Sales pipeline stages |
| /distributors | EU distributor network |
| /buyer-intent | Distributor buying intent signals |
| /distributor-matches | Brand–distributor match table |
| /reports | Weekly digests + monthly briefs |

---

## Database Schema (35 tables)

Core: `brands`, `products`, `euMarketSignals`, `agentOutputs`
Trade data: `tradeFlowIntelligence`, `tradeFlowMonthly`, `tradeFlowData`, `competitorMarketShare`, `tradeFlowAnalytics`
Signals: `gapScores`, `retailerInsights`, `retailerActivities`, `niRoutingSignals`, `opportunityCorrelations`, `opportunityScores`
Trends: `trends`, `humanReviewItems`
Trade shows: `tradeShows`, `tradeShowExhibitors`, `tradeShowPlaybooks`
Insights: `insights`, `triggerRules`
Leads: `leads`, `leadCampaigns`, `leadBriefings`, `leadPipeline`
Distributors: `distributors`, `distributorBuyingIntent`, `distributorBrandMatches`, `regulatoryFlags`
Ops: `crawlJobs`

---

## Key Design Decisions
- NI Routing: Northern Ireland dual-market position is a core differentiator; NI Suitability is one of three scoring dimensions
- Composite Score: `(CategoryScore × 0.40) + (BrandScore × 0.35) + (NIScore × 0.25)`
- Lead score formula: `compositeScore×0.35 + gapScore×0.22 + trendBonus×0.18 + contactBonus×0.12 + distributorBonus(max 15) - regulatoryPenalty(0/8/20)`
- Distributor match score: `categoryOverlap×0.50 + maxIntentStrength×0.35 + distributorScore/100×0.15`
- Email: Resend (not SendGrid)
- CRM: Lightweight custom layer; HubSpot integration optional later
- Deployment: Railway
- DeepSeek API: used for pitch angle expansion, insight narratives, trade show playbooks (template fallback if API unavailable)

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
npm run db:push          — Push schema changes to DB (dev only — must be run manually)
npm run db:generate      — Generate Drizzle migration files
npm run db:studio        — Open Drizzle Studio UI
docker-compose up postgres redis  — Start local DB + Redis
npx vitest run           — Run 55 unit/integration tests (from apps/api)
```

## Database Notes
- pgvector extension must be enabled before pushing schema
- Run in psql: `CREATE EXTENSION IF NOT EXISTS vector;`
- All tables in `apps/api/src/db/schema.ts`
- `apps/api/src/db/migrate.ts` enables uuid-ossp + pgvector extensions on startup — it does NOT create tables
- **Tables must be created via `npm run db:push`** before first run (not automatic on Railway deploy)
- Three analytics tables applied via script (not drizzle-kit) to avoid --force prompt interception:
  - `trade_flow_monthly`      — monthly Comtrade data (YYYYMM, Jan 2022–Dec 2023)
  - `competitor_market_share` — EU country imports from WORLD / US / CN / GB per HS chapter
  - `trade_flow_analytics`    — computed multi-layer analytics (OLS, CAGR, acceleration, shares)
- To apply analytics tables: `node --env-file=apps/api/.env scripts/apply-analytics-tables.mjs`
- Distribution tables (new): `node --env-file=apps/api/.env scripts/add-distribution-tables.mjs`
- `opportunity_correlations` table: upserted on each agent run; unique constraint on `(category, country_code)`

## Known Production Gaps (Phase 6)

These are the gaps between current state and production-ready software:

1. **`playwright-extra` not installed** — All Playwright crawlers import `playwright-extra` and `puppeteer-extra-plugin-stealth`, neither of which is in package.json. TypeScript compiles (ambient declarations in `src/types/vendor.d.ts`), but at runtime the imports will crash. Install: `npm install playwright-extra puppeteer-extra-plugin-stealth` in `apps/api`.

2. **No dashboard authentication** — The dashboard (`apps/dashboard`) has zero auth. Anyone with the URL can view all data and trigger agents. Add NextAuth.js or a simple password middleware before exposing to any network.

3. **Schema must be applied manually on first Railway deploy** — `runMigrations()` only creates PostgreSQL extensions. Tables are created via `npm run db:push`, which must be run once from your dev machine pointed at the Railway `DATABASE_URL`: `DATABASE_URL=<railway-url> npm run db:push --workspace=apps/api`. Re-run after any schema changes. Do not try to run `db:push` from inside the Docker container — the image only contains `dist/`, not the TypeScript source that `drizzle-kit` requires.

4. **CRM export writes to local filesystem** — `CRMExportAgent` writes to `exports/crm-leads-<date>.json`. In Railway containers, the filesystem is ephemeral — files disappear on restart/redeploy. Move to S3, Railway Volumes, or email the export via Resend.

5. **No real brand seed data** — The pipeline generates scores against brands in the `brands` table, but no seed data is loaded. Without real brands (Shopify crawl results), the pipeline produces empty outputs on a fresh deploy. Need either a seed script with known US CPG brands or a first-run Shopify crawl.

6. **Trade data is public preview** — UN Comtrade's free preview has aggressive rate limits and gaps in coverage. A paid Comtrade+ API key would significantly improve data quality and reduce 429 errors.

7. **No structured logging/monitoring** — The API logs via `pino` (JSON to stdout) which Railway captures, but there's no alerting on agent failures, no Sentry-style error tracking, and no dashboard for pipeline health (failed steps, empty runs, data staleness).

8. **`CompetitorIntelligenceAgent` not implemented** — This agent was planned to map which distributors carry which US brands. Deferred indefinitely; the rest of the distributor pipeline works without it.

9. **Webhook secret not enforced in dev** — `RESEND_WEBHOOK_SECRET` is optional; when absent the webhook endpoint accepts all payloads without signature verification. Fine for dev, must be set in production.

10. **`outreachCampaigns` table is deprecated** — The schema still contains `outreachCampaigns` (distinct from `leadCampaigns`). The former is unused; should be dropped in a migration to reduce confusion.

---

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
