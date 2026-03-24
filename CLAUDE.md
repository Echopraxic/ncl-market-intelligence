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
- AI: Anthropic Claude API — model: claude-sonnet-4-6
- Frontend: Next.js 14 + Tailwind CSS (apps/dashboard)
- Email: Resend
- Package Manager: npm workspaces (monorepo)

## Monorepo Structure
apps/api        — Fastify API, BullMQ workers, all agents
apps/dashboard  — Next.js 14 internal-only dashboard (no auth yet)
packages/shared — Shared TypeScript types

## Development Phases
| Phase | Weeks | Status |
|-------|-------|--------|
| 1 — Foundation       | 1–4   | In Progress (Week 1 scaffolding complete) |
| 2 — Intelligence     | 5–8   | Not started |
| 3 — Scoring/Insights | 9–12  | Not started |
| 4 — Automation       | 13–16 | Not started |

## Key Design Decisions
- NI Routing: Northern Ireland dual-market position is a core advantage; NI Suitability is one of three scoring dimensions
- Human Oversight First: ALL external-facing actions require human approval until system is trusted (see Section 11 of dev plan)
- Composite Score: (CategoryScore x 0.40) + (BrandScore x 0.35) + (NIScore x 0.25)
- Email: Resend (not SendGrid)
- CRM: Lightweight custom layer (Phase 4); HubSpot integration optional later
- Deployment: Railway

## Scoring Thresholds (apps/api/src/config/scoring-weights.json)
- Trending category: >15% growth rate
- Opportunity alert: composite_score > 80
- Lead generation: composite > 75 AND category > 70
- Outreach trigger: composite > 80
- Human approval required if: composite_score < 70
- Max outreach/day: 50 | Min gap between emails to same brand: 3 days

## Target EU Markets
DE (Germany), FR (France), NL (Netherlands), GB (United Kingdom), ES (Spain), IT (Italy)

## Approval Gates — NEVER skip without explicit human sign-off
- First 50 outreach emails to any new brand segment
- Any insight/report marked for external distribution
- Scoring weight or trigger threshold changes
- New crawler sources added
- Email template changes
- Any outreach to brand with composite_score < 70

## Commands
npm run dev:api          — Start API dev server (port 3001)
npm run dev:dashboard    — Start dashboard dev server (port 3000)
npm run db:push          — Push schema changes to DB (dev)
npm run db:generate      — Generate Drizzle migration files
npm run db:studio        — Open Drizzle Studio UI
docker-compose up postgres redis  — Start local DB + Redis

## Database Notes
- pgvector extension must be enabled before pushing schema
- Run in psql: CREATE EXTENSION IF NOT EXISTS pgvector;
- All tables in apps/api/src/db/schema.ts
- description_embedding vector(1536) on products table added via raw SQL after extension enabled
