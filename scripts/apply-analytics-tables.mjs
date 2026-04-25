/**
 * scripts/apply-analytics-tables.mjs
 *
 * Applies the three new analytics tables to Postgres without triggering
 * drizzle-kit's interactive --force prompt.
 *
 * Run from monorepo root:
 *   node --env-file=apps/api/.env scripts/apply-analytics-tables.mjs
 */

import pg from 'pg';

const { Client } = pg;
const client = new Client({ connectionString: process.env.DATABASE_URL });

await client.connect();
console.log('Connected to Postgres. Applying analytics tables…');

// ── 1. trade_flow_monthly ────────────────────────────────────────────────────
await client.query(`
  CREATE TABLE IF NOT EXISTS trade_flow_monthly (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    flow_type     TEXT    NOT NULL,
    reporter_country TEXT NOT NULL,
    partner_country  TEXT NOT NULL,
    ncl_category  TEXT    NOT NULL,
    hs_chapter    TEXT    NOT NULL,
    year_month    INTEGER NOT NULL,
    trade_value_usd REAL,
    net_weight_kg   REAL,
    source        TEXT    NOT NULL DEFAULT 'comtrade',
    fetched_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`);
await client.query(`
  CREATE UNIQUE INDEX IF NOT EXISTS tfm_unique_idx
    ON trade_flow_monthly (flow_type, reporter_country, partner_country, ncl_category, hs_chapter, year_month);
`);
await client.query(`
  CREATE INDEX IF NOT EXISTS tfm_year_month_idx  ON trade_flow_monthly (year_month);
`);
await client.query(`
  CREATE INDEX IF NOT EXISTS tfm_category_idx ON trade_flow_monthly (ncl_category, year_month);
`);
console.log('✓ trade_flow_monthly');

// ── 2. competitor_market_share ───────────────────────────────────────────────
await client.query(`
  CREATE TABLE IF NOT EXISTS competitor_market_share (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    eu_country      TEXT    NOT NULL,
    hs_chapter      TEXT    NOT NULL,
    ncl_category    TEXT    NOT NULL,
    year            INTEGER NOT NULL,
    partner_country TEXT    NOT NULL,
    import_value_usd  REAL,
    market_share_pct  REAL,
    fetched_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`);
await client.query(`
  CREATE UNIQUE INDEX IF NOT EXISTS cms_unique_idx
    ON competitor_market_share (eu_country, hs_chapter, year, partner_country);
`);
await client.query(`
  CREATE INDEX IF NOT EXISTS cms_country_year_idx ON competitor_market_share (eu_country, year);
`);
console.log('✓ competitor_market_share');

// ── 3. trade_flow_analytics ──────────────────────────────────────────────────
await client.query(`
  CREATE TABLE IF NOT EXISTS trade_flow_analytics (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    flow_type                TEXT    NOT NULL,
    reporter_country         TEXT    NOT NULL,
    partner_country          TEXT    NOT NULL,
    ncl_category             TEXT    NOT NULL,
    hs_chapter               TEXT    NOT NULL,
    as_of_year               INTEGER NOT NULL,
    -- Growth metrics
    yoy_growth_pct           REAL,
    cagr_3yr                 REAL,
    cagr_5yr                 REAL,
    -- Rolling averages (from monthly data)
    avg_6m_usd               REAL,
    avg_12m_usd              REAL,
    -- Momentum / acceleration
    short_term_momentum      REAL,
    acceleration_score       REAL,
    is_accelerating          BOOLEAN NOT NULL DEFAULT FALSE,
    -- OLS regression
    linear_trend_slope       REAL,
    r_squared                REAL,
    -- Breakpoint detection
    breakpoint_detected      BOOLEAN NOT NULL DEFAULT FALSE,
    breakpoint_year          INTEGER,
    breakpoint_type          TEXT,
    first_half_slope         REAL,
    second_half_slope        REAL,
    -- US market share vs competitors
    us_market_share_pct      REAL,
    us_market_share_prior_pct REAL,
    share_change_pct         REAL,
    share_trend              TEXT,
    china_market_share_pct   REAL,
    uk_market_share_pct      REAL,
    row_market_share_pct     REAL,
    us_vs_china_share_diff   REAL,
    -- Saturation signal
    us_growth_vs_market_ratio REAL,
    saturation_risk_score    REAL,
    -- Eurostat consumption cross-reference (best-effort)
    eu_consumption_eur_m     REAL,
    import_intensity_pct     REAL,
    consumption_growth_pct   REAL,
    computed_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`);
await client.query(`
  CREATE UNIQUE INDEX IF NOT EXISTS tfa_unique_idx
    ON trade_flow_analytics (flow_type, reporter_country, partner_country, ncl_category, hs_chapter, as_of_year);
`);
await client.query(`
  CREATE INDEX IF NOT EXISTS tfa_accelerating_idx ON trade_flow_analytics (is_accelerating, acceleration_score);
`);
await client.query(`
  CREATE INDEX IF NOT EXISTS tfa_share_idx ON trade_flow_analytics (partner_country, ncl_category, as_of_year);
`);
console.log('✓ trade_flow_analytics');

await client.end();
console.log('\nAll analytics tables applied successfully.');
