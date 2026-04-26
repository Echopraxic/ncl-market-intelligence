# Railway Deployment Guide — NCL Market Intelligence Engine

## Architecture on Railway

| Service | Dockerfile | Port | Railway template |
|---------|-----------|------|-----------------|
| ncl-api | `Dockerfile` (root) | 3001 | GitHub → build from root |
| ncl-dashboard | `apps/dashboard/Dockerfile` | 3000 | GitHub → custom Dockerfile path |
| PostgreSQL | Railway Postgres plugin | 5432 | Add plugin to project |
| Redis | Railway Redis plugin | 6379 | Add plugin to project |

---

## Step 1 — Create Railway project

1. Go to [railway.app](https://railway.app) → **New Project**
2. Choose **Empty Project**

---

## Step 2 — Add database plugins

In the Railway project dashboard:

1. **New** → **Database** → **PostgreSQL** — Railway auto-sets `DATABASE_URL`
2. **New** → **Database** → **Redis** — Railway auto-sets `REDIS_URL`

After PostgreSQL is provisioned:
- Connect via `psql "$DATABASE_URL"` or Railway's query tab
- Run: `CREATE EXTENSION IF NOT EXISTS pgvector;`
  - The migration runner handles all table creation automatically on first startup

---

## Step 3 — Deploy the API service

1. **New** → **GitHub Repo** → select `ncl-market-intelligence`
2. Railway detects `railway.toml` at root → uses `Dockerfile` (API build)
3. Set environment variables (Settings → Variables):

```
DATABASE_URL       = (auto-filled by Postgres plugin)
REDIS_URL          = (auto-filled by Redis plugin)
API_SECRET_KEY     = <generate: openssl rand -hex 32>
DEEPSEEK_API_KEY   = sk-...
RESEND_API_KEY     = re_...
RESEND_WEBHOOK_SECRET = whsec_...
EMAIL_FROM         = outreach@yourdomain.com
DASHBOARD_URL      = https://ncl-dashboard.up.railway.app
NODE_ENV           = production
PORT               = 3001
```

4. Click **Deploy** — Railway builds the Docker image and starts the container
5. On first start, `runMigrations()` creates all tables idempotently
6. Health check: `GET https://ncl-api.up.railway.app/health` → `{"status":"ok","db":"connected"}`

---

## Step 4 — Deploy the dashboard service

1. **New** → **GitHub Repo** → same repo
2. In service **Settings** → **Build**:
   - **Dockerfile Path**: `apps/dashboard/Dockerfile`
   - **Build context**: `/` (root — must have access to workspace root)
3. Set environment variables:

```
API_URL        = https://ncl-api.up.railway.app   (or Railway private network URL)
API_SECRET_KEY = <same value as API service>
NODE_ENV       = production
PORT           = 3000
```

4. **Custom Domain** (optional): add `ncl-dashboard.up.railway.app` or your own domain

---

## Step 5 — Configure Resend webhook

In Resend dashboard → Webhooks:
- URL: `https://ncl-api.up.railway.app/api/webhooks/resend`
- Events: `email.opened`, `email.clicked`, `email.bounced`, `email.complained`, `email.delivered`
- Copy the webhook signing secret → set `RESEND_WEBHOOK_SECRET` in Railway

---

## Step 6 — Seed default trigger rules (optional)

After the API is running, insert a default trigger rule via psql or the Railway query tab:

```sql
INSERT INTO trigger_rules (rule_name, conditions, action_type, action_config, is_active)
VALUES (
  'high-composite-alert',
  '{"metric": "compositeScore", "operator": ">", "threshold": 80}',
  'alert_insight',
  '{"type": "alert_insight"}',
  true
);
```

---

## Environment variable reference

All variables are in `.env.railway.example` at the repo root.

---

## Database migration

Migrations run **automatically on every API startup** via `runMigrations()` in `src/db/migrate.ts`.

All DDL uses `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` — safe to run repeatedly.

If you need to apply schema changes manually:
```bash
# Connect to Railway Postgres
railway run --service ncl-api psql "$DATABASE_URL"
```

---

## Build notes

- **Image size**: ~2.5 GB due to Playwright + Chromium for EU market crawlers. Railway supports images up to 4 GB.
- **Build time**: ~8–12 min on first build (Playwright install). Subsequent builds use layer cache.
- **Redis version**: Railway Redis 7 satisfies BullMQ's Redis 5+ requirement, resolving the Windows dev blocker.
- **pgvector**: Must be enabled as a Postgres extension before first startup. Railway's managed Postgres supports pgvector — enable it in the query tab as shown above.

---

## Local → Railway parity

| Concern | Local | Railway |
|---------|-------|---------|
| Redis | Redis 3 (Windows, BullMQ degraded) | Redis 7 (full BullMQ support) |
| Postgres | Docker pgvector/pg16 | Railway managed Postgres with pgvector |
| API start | `npm run dev:api` | `node dist/index.js` |
| Dashboard start | `npm run dev:dashboard` | Next.js standalone `server.js` |
| Migrations | `npm run db:push` | Automatic via `runMigrations()` on startup |
