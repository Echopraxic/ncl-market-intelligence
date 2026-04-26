# NCL Market Intelligence Engine

An automated EU market opportunity discovery system for North Channel Logistics (NCL). The engine identifies US consumer brands with high potential for EU expansion, routes intelligence through a multi-agent pipeline, and delivers scored opportunities and outreach-ready leads — before brands know the opportunity exists.

---

## What it does

NCL's traditional business is reactive: brands come to them asking for help entering EU markets. This system flips that model. It continuously monitors EU trade data, search trends, retailer behaviour, and Shopify storefronts to find US brands worth approaching, score them against EU demand signals, and prepare pitch-ready briefings — autonomously.

The pipeline answers four questions:

| Question | Agents Involved |
|----------|----------------|
| What categories are growing in which EU markets? | Google Trends, Amazon EU, Trade Flow Intelligence, Statistical Trend Engine |
| Which US brands are best positioned to capitalise? | Shopify Brand Crawler, Brand Fit Scoring, Composite Scoring |
| Where are EU buyers actively sourcing? | Retailer Behavior Agent, Cross-Signal Correlation, NI Routing |
| Where are deals forming? | Trade Show Crawler, Trade Show Playbook Agent, Lead Discovery |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Data Ingestion                           │
│  AmazonEUCrawler  GoogleTrendsCrawler  TradeShowCrawler         │
│  ShopifyBrandCrawler  ProductHuntCrawler  LinkedInCrawler       │
│  TradeFlowIntelligenceAgent  (UN Comtrade / Eurostat)           │
└───────────────────────────┬─────────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────────┐
│                    Signal Processing                            │
│  StatisticalTrendEngine  →  TrendValidator  →  TrendScheduler  │
│  DemandSupplyGapAgent  RetailerBehaviorAgent                    │
│  CrossSignalCorrelationAgent  NIRoutingAgent                    │
└───────────────────────────┬─────────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────────┐
│                    Scoring & Insights                           │
│  CompositeScoringAgent  BrandFitScoringAgent                   │
│  InsightGenerationAgent  TradeShowPlaybookAgent                 │
│  ReportGeneratorAgent                                           │
└───────────────────────────┬─────────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────────┐
│                    Lead Generation                              │
│  LeadDiscoveryAgent  LeadScoringAgent  PitchAngleAgent         │
│  LeadOutreachAgent  LeadEngagementAgent  CRMExportAgent        │
└───────────────────────────┬─────────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────────┐
│                    Orchestration                                │
│  MasterSchedulerAgent  TriggerRulesEngine                      │
│  (weekly cron via BullMQ / direct execution fallback)          │
└─────────────────────────────────────────────────────────────────┘
```

**Tech stack**

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20 LTS, TypeScript (ESM) |
| API | Fastify 5 |
| Database | PostgreSQL 16 + pgvector |
| Queue | Redis 7 + BullMQ |
| ORM | Drizzle ORM |
| AI | DeepSeek API (narrative generation) |
| Browser automation | Playwright + Chromium |
| Dashboard | Next.js 14 + Tailwind CSS |
| Email | Resend |

---

## Features

### Data collection
- **Amazon EU crawler** — scrapes product listings across DE, FR, NL, ES, IT for 5 NCL product categories; detects US brands with EU listings
- **Google Trends crawler** — pulls weekly trend data per (country, category) pair across 6 EU markets
- **Shopify Brand crawler** — discovers US brands on Shopify via Google search, validates storefronts, checks EU presence; skips already-checked brands
- **Trade Show crawler** — scrapes exhibitor lists from major trade shows (NRF, Toy Fair, Natural Products Expo, etc.)
- **LinkedIn / ProductHunt / CPG Directory crawlers** — enriches lead candidate data with hiring signals and founding info
- **UN Comtrade trade flow data** — annual and monthly US↔EU import/export volumes per HS chapter

### Signal processing
- **Statistical Trend Engine** — OLS regression, CAGR, breakpoint detection, seasonality filtering, volatility scoring; classifies trends into 6 tiers (breakthrough → watch)
- **Demand/Supply Gap Agent** — percentile-ranked gap score: `(demand × 0.40) + (import reliance × 0.35) + (1 − brand density × 0.25)`
- **Retailer Behavior Agent** — detects expansion, category rotation, and US brand entry patterns from retailer activity data
- **Cross-Signal Correlation Agent** — bundles lead-lag relationships between retailer surges and trade flow spikes; maps distributor coverage gaps
- **NI Routing Agent** — computes Northern Ireland suitability signals: Irish Sea routing advantage, UK re-export arbitrage, air freight suitability, distributor gap detection

### Scoring
Composite score formula: `(CategoryScore × 0.40) + (BrandScore × 0.35) + (NIScore × 0.25)`

| Score | Threshold | Action |
|-------|-----------|--------|
| > 80 | Breakthrough | Auto-queue outreach (human approval required to send) |
| 70–80 | Accelerating | Human review queue |
| 60–70 | Sustained | Monitor |
| < 60 | Mature/Watch | No action |

- **Composite Scoring Agent** — scores every (category × country) corridor
- **Brand Fit Scoring Agent** — scores every brand against every active corridor
- **Trigger Rules Engine** — evaluates configurable `trigger_rules` table; fires alert insights or queues leads when thresholds are crossed

### Insights & reports
- **Insight Generation Agent** — DeepSeek-powered narrative synthesis of opportunity alerts, market briefs, trade show playbooks, and weekly reports
- **Trade Show Playbook Agent** — per-show exhibitor × brand matching with distributor coverage maps and pitch angle recommendations
- **Report Generator** — weekly executive digest + monthly market brief, auto-deduplicated by ISO week / calendar month

### Lead generation
- **Lead Discovery Agent** — aggregates candidates from all crawlers + scored brands + trade show exhibitors; deduplicates by website URL
- **Lead Scoring Agent** — `leadQualityScore = compositeScore×0.40 + gapScore×0.25 + trendTierBonus×0.20 + contactCompleteness×0.15`
- **Pitch Angle Agent** — selects angle (first_mover / unmet_demand / cost_optimisation / margin_expansion) and expands with DeepSeek
- **Lead Outreach Agent** — generates email + HTML briefing pack; queues in `humanReviewItems` for human approval before sending
- **Lead Engagement Agent** — handles Resend webhooks; classifies reply sentiment, advances pipeline stage
- **CRM Export Agent** — weekly JSON export of qualified leads

### Automation policy
Everything runs automatically except sending emails to real people. Outreach emails are drafted and queued — a human must approve before anything leaves the system.

---

## Local deployment

### Quick start (automated)

**Prerequisites:** Node.js 20+, Docker, Docker Compose

```bash
# One-command setup: starts PostgreSQL + Redis, installs deps, creates .env
bash c:/Users/mikey/ncl-market-intelligence/scripts/setup-local.sh
bash scripts/setup-local.sh

# Then edit .env with your API keys:
# - DEEPSEEK_API_KEY (from platform.deepseek.com)
# - RESEND_API_KEY + RESEND_WEBHOOK_SECRET (from resend.com)

# Start both servers:
make dev

# Dashboard: http://localhost:3000
# API health check: http://localhost:3001/health
```

### Manual setup (step-by-step)

If you prefer to control each step:

```bash
# 1. Start PostgreSQL 16 + pgvector and Redis 7
docker-compose up -d postgres redis

# 2. Install dependencies
npm install

# 3. Create .env (auto-created by setup script, or manually):
cat > .env << 'EOF'
DATABASE_URL=postgresql://ncl_user:ncl_password@localhost:5432/ncl_mie
REDIS_URL=redis://localhost:6379
API_SECRET_KEY=any-local-secret-key
DEEPSEEK_API_KEY=sk-...        # from platform.deepseek.com
RESEND_API_KEY=re_...          # from resend.com (optional)
RESEND_WEBHOOK_SECRET=whsec_... # from Resend webhook settings (optional)
EMAIL_FROM=outreach@yourdomain.com
DASHBOARD_URL=http://localhost:3000
NODE_ENV=development
EOF

# 4. Start the API (schema migrations run automatically)
npm run dev:api
# → http://localhost:3001

# 5. In another terminal, start the dashboard
npm run dev:dashboard
# → http://localhost:3000

# 6. Verify
curl -H "x-api-key: any-local-secret-key" http://localhost:3001/health
# {"status":"ok","db":"connected"}
```

### Convenience commands

```bash
make local-setup    # Run full automated setup
make dev            # Start API and dashboard
make stop           # Stop Docker containers
make logs           # View container logs
make test           # Run vitest suite
make clean          # Remove containers, volumes, node_modules
make db-push        # Apply schema changes
make db-studio      # Open Drizzle Studio UI
```

> **Note on DeepSeek:** Used only for narrative generation (insight bodies, pitch summaries). Everything else — crawling, scoring, gap analysis, lead discovery — runs without it. If `DEEPSEEK_API_KEY` is absent, agents fall back to rule-based template output.

---

## Pipeline walkthrough

Here is a full end-to-end example of how the system discovers and converts an opportunity.

### Option A — Run everything at once

Trigger the master scheduler, which runs all agents in sequence:

```bash
curl -X POST http://localhost:3001/api/agents/master-scheduler/run \
  -H "x-api-key: any-local-secret-key"
```

This runs:
1. Trade flow intelligence + analytics
2. NI routing signals
3. All four crawlers (Shopify, Google Trends, Amazon EU, Trade Shows)
4. Trend detection → gap scoring → retailer behavior → correlation → composite scoring → brand fit → insight generation
5. Lead discovery → lead scoring → pitch angles → CRM export
6. Trigger rules evaluation

Duration: 20–45 minutes on first run (crawlers are rate-limited). Subsequent runs are faster since data is cached.

---

### Option B — Step through the pipeline manually

**Step 1 — Collect trade flow data**

```bash
curl -X POST http://localhost:3001/api/agents/trade-flow/run \
  -H "x-api-key: your-key"

curl -X POST http://localhost:3001/api/agents/trade-analytics/run \
  -H "x-api-key: your-key"
```

After ~2 minutes, check what was collected:

```bash
curl "http://localhost:3001/api/trade-flows?category=supplements&limit=5" \
  -H "x-api-key: your-key"
```

---

**Step 2 — Run the crawlers**

```bash
# Discover US brands on Shopify
curl -X POST http://localhost:3001/api/crawlers/shopify-brand/trigger \
  -H "x-api-key: your-key"

# Pull Google Trends data for EU markets
curl -X POST http://localhost:3001/api/crawlers/google-trends/trigger \
  -H "x-api-key: your-key"
```

Monitor crawler progress:

```bash
curl "http://localhost:3001/api/crawl-jobs" -H "x-api-key: your-key"
# Shows status, records found, pages crawled, duration for each run
```

---

**Step 3 — Detect trends**

The trend scheduler runs detection, validates results, and triggers the full downstream chain (gap → retailer → correlation → composite → brand-fit → insights) automatically:

```bash
curl -X POST http://localhost:3001/api/agents/trends/run \
  -H "x-api-key: your-key"

# Check what was found
curl "http://localhost:3001/api/trends?tier=breakthrough&limit=10" \
  -H "x-api-key: your-key"
```

A breakthrough trend looks like:

```json
{
  "category": "supplements",
  "countryCode": "DE",
  "growthRate": 0.67,
  "opportunityTier": "breakthrough",
  "confidence": 0.91,
  "isAccelerating": true
}
```

---

**Step 4 — View opportunity scores**

```bash
# Top corridors (category × country) by composite score
curl "http://localhost:3001/api/opportunity-scores?limit=10" \
  -H "x-api-key: your-key"

# Top brand fits for Germany
curl "http://localhost:3001/api/brand-scores?countryCode=DE&minComposite=70" \
  -H "x-api-key: your-key"
```

Example corridor score:

```json
{
  "category": "supplements",
  "countryCode": "DE",
  "compositeScore": 84.2,
  "categoryOpportunityScore": 91.0,
  "brandFitScore": 0,
  "niSuitabilityPreScore": 72.5
}
```

---

**Step 5 — Review generated insights**

The trend scheduler automatically triggers `InsightGenerationAgent` after scoring. View results:

```bash
# Opportunity alerts (composite > 80)
curl "http://localhost:3001/api/insights?type=opportunity_alert" \
  -H "x-api-key: your-key"

# Weekly digest
curl "http://localhost:3001/api/insights?type=weekly_report" \
  -H "x-api-key: your-key"
```

---

**Step 6 — Lead pipeline**

```bash
# Run lead discovery (aggregates from crawlers + scored brands)
curl -X POST http://localhost:3001/api/agents/lead-discovery/run \
  -H "x-api-key: your-key"

# Score leads
curl -X POST http://localhost:3001/api/agents/lead-scoring/run \
  -H "x-api-key: your-key"

# Generate pitch angles
curl -X POST http://localhost:3001/api/agents/pitch-angle/run \
  -H "x-api-key: your-key"

# Review leads in the pipeline
curl "http://localhost:3001/api/leads?minScore=70&status=new" \
  -H "x-api-key: your-key"
```

A scored lead looks like:

```json
{
  "companyName": "Ancient Nutrition",
  "websiteUrl": "https://ancientnutrition.com",
  "bestCategory": "supplements",
  "bestCountryCode": "DE",
  "leadQualityScore": 78.4,
  "pitchAngle": "first_mover",
  "pitchSummary": "Germany supplements market growing 67% YoY — no confirmed EU distributor. Windsor Framework routing via NI offers 3–4 week faster market entry than direct.",
  "status": "new"
}
```

---

**Step 7 — Approve outreach**

Leads above the threshold are automatically drafted. A human reviews and approves in the dashboard at `/outreach-queue`, or via API:

```bash
# View items awaiting approval
curl "http://localhost:3001/api/human-review?type=lead_outreach&status=pending" \
  -H "x-api-key: your-key"

# Approve an item (this does NOT send the email — it marks it as approved)
curl -X PATCH http://localhost:3001/api/human-review/ITEM_ID \
  -H "x-api-key: your-key" \
  -H "Content-Type: application/json" \
  -d '{"status": "approved", "reviewedBy": "mike"}'

# Send approved campaigns
curl -X POST http://localhost:3001/api/campaigns/CAMPAIGN_ID/send \
  -H "x-api-key: your-key"
```

---

## Dashboard pages

| Page | URL | What it shows |
|------|-----|---------------|
| Overview | `/` | Summary stats for all pipeline stages |
| Brands | `/brands` | All discovered US brands with EU presence flag |
| Market Signals | `/signals` | Raw EU demand/supply signals by country |
| Trends | `/trends` | Detected trends with tier, confidence, growth rate |
| Gap Scores | `/gaps` | Category × country gap leaderboard |
| Retailer Insights | `/retailer-insights` | Expansion and rotation patterns by market |
| Trade Analytics | `/trade-analytics` | OLS acceleration, CAGR, competitor share |
| Opportunities | `/opportunities` | Composite score leaderboard (corridors + brands) |
| Insights | `/insights-feed` | Generated AI narrative insights |
| Trade Shows | `/trade-shows` | Upcoming shows with exhibitor counts |
| Human Review | `/human-review` | Approve/reject trends and outreach items |
| Leads | `/leads` | Full lead pipeline with scores and pitch angles |
| Outreach Queue | `/outreach-queue` | Email drafts awaiting human approval |
| Lead Pipeline | `/lead-pipeline` | CRM-style pipeline stage view |
| Reports | `/reports` | Weekly digests and monthly market briefs |
| Crawl Jobs | `/crawl-jobs` | Crawler run history with error details |

---

## Target markets

Germany (DE), France (FR), Netherlands (NL), United Kingdom (GB), Spain (ES), Italy (IT)

---

## Product categories

| NCL Category | HS Chapters | Examples |
|-------------|-------------|---------|
| `food_beverage` | 16–24 | Snacks, sauces, drinks, confectionery |
| `supplements` | 30, 2106 | Vitamins, protein, nootropics, collagen |
| `cosmetics_personal_care` | 33 | Skincare, haircare, personal hygiene |
| `home_goods` | 94 | Furniture, bedding, lighting, storage |
| `toys_games` | 95 | Educational toys, STEM kits, games, puzzles |

---

## Opportunity tier taxonomy

| Tier | Growth Rate | NCL Strategy |
|------|-------------|-------------|
| `breakthrough` | > 50% YoY | Immediate outreach — first-mover window |
| `accelerating` | 25–50% | Competitive entry — proven demand |
| `sustained` | 10–25% | NI routing efficiency pitch |
| `mature` | 5–10% | Niche targeting or differentiation |
| `disrupted` | < 0% | Vacuum-fill — structural shifts |
| `watch` | Volatile | Monitor only, no resource allocation |

---

## Project structure

```
ncl-market-intelligence/
├── apps/
│   ├── api/                        # Fastify API + all agents
│   │   └── src/
│   │       ├── agents/
│   │       │   ├── crawlers/       # Web scraping agents
│   │       │   ├── lead-gen/       # Lead discovery and outreach
│   │       │   ├── normalization/  # Rule-based and AI structuring
│   │       │   └── signals/        # Trend, gap, scoring, insight agents
│   │       ├── api/
│   │       │   └── server.ts       # All Fastify routes
│   │       ├── db/
│   │       │   ├── schema.ts       # Drizzle ORM schema (single source of truth)
│   │       │   └── migrate.ts      # Idempotent production migration runner
│   │       └── lib/                # Logger, email, trade flow client
│   └── dashboard/                  # Next.js 14 internal dashboard
│       └── src/app/                # One folder per dashboard page
├── packages/
│   └── shared/                     # Shared TypeScript types
├── scripts/                        # One-off migration scripts
├── Dockerfile                      # API production image
├── DEPLOY.md                       # Railway deployment guide
└── railway.toml                    # Railway service config
```

---

## Running tests

```bash
npm run test            # All tests (vitest)
npm run test:coverage   # With coverage report
```

Coverage thresholds: 40% functions, 40% branches (crawlers excluded — Playwright-heavy).

---

## Deploying to production

See [DEPLOY.md](DEPLOY.md) for the full Railway deployment guide.

The short version: Railway provides managed PostgreSQL (with pgvector) and Redis 7 (resolving the Windows local Redis version constraint). Both services auto-inject connection strings as environment variables. The API runs schema migrations automatically on startup via `runMigrations()`.
