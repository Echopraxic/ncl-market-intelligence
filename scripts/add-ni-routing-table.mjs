/**
 * scripts/add-ni-routing-table.mjs
 *
 * Creates the ni_routing_signals table for Phase 3 NI routing intelligence.
 * Safe to re-run — uses CREATE TABLE IF NOT EXISTS.
 *
 * Run from monorepo root:
 *   node --env-file=apps/api/.env scripts/add-ni-routing-table.mjs
 */

import pg from 'pg';

const { Client } = pg;
const client = new Client({ connectionString: process.env.DATABASE_URL });

await client.connect();
console.log('Connected to Postgres. Creating NI routing tables…');

await client.query(`
  CREATE TABLE IF NOT EXISTS ni_routing_signals (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ncl_category    TEXT    NOT NULL,
    hs_chapter      TEXT,
    -- ISO-2 EU country, or 'ALL' for category-wide signals (e.g. air_freight_suitable)
    eu_country      TEXT    NOT NULL,
    -- 'irish_sea_routing' | 'uk_reexport_arb' | 'air_freight_suitable' | 'distributor_gap'
    signal_type     TEXT    NOT NULL,
    -- Normalised 0–1
    signal_strength REAL    NOT NULL,
    -- Which NI sub-dimension this feeds:
    --   'vat_advantage' | 'distribution_efficiency' | 'regulatory_clarity'
    ni_sub_dimension TEXT   NOT NULL,
    -- Raw evidence (growth rates, USD values, distributor counts, etc.)
    evidence        JSONB   NOT NULL,
    computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`);
console.log('✓ ni_routing_signals table');

await client.query(`
  CREATE INDEX IF NOT EXISTS ni_signals_category_country_idx
    ON ni_routing_signals (ncl_category, eu_country);
`);
await client.query(`
  CREATE INDEX IF NOT EXISTS ni_signals_type_idx
    ON ni_routing_signals (signal_type, signal_strength);
`);
await client.query(`
  CREATE INDEX IF NOT EXISTS ni_signals_computed_at_idx
    ON ni_routing_signals (computed_at);
`);
console.log('✓ Indexes created');

await client.end();
console.log('\nNI routing table applied successfully.');
