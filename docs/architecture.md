# Architecture

## Pipeline
Data Ingestion -> Normalization -> Signal Extraction -> Scoring -> Insight Generation -> Action Triggers

## Services
- API (apps/api): Fastify + BullMQ workers + all agents
- Dashboard (apps/dashboard): Next.js 14 internal UI
- Shared (packages/shared): Shared TypeScript types

## Infrastructure
- PostgreSQL 16 + pgvector: relational + vector search
- Redis 7 + BullMQ: job scheduling and pub/sub
- Docker Compose for local dev

## Agent Pipeline
Crawlers -> DB -> DataStructuringAgent -> SignalAgents -> ScoringEngine -> InsightSynthesisAgent -> ActionTriggerEngine
