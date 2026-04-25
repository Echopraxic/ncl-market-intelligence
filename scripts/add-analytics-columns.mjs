/**
 * scripts/add-analytics-columns.mjs
 *
 * Adds the four new analytics columns to trade_flow_analytics.
 * Safe to re-run — uses ADD COLUMN IF NOT EXISTS.
 *
 * Run from monorepo root:
 *   node --env-file=apps/api/.env scripts/add-analytics-columns.mjs
 */

import pg from 'pg';

const { Client } = pg;
const client = new Client({ connectionString: process.env.DATABASE_URL });

await client.connect();
console.log('Connected to Postgres. Adding new analytics columns…');

const alterations = [
  // Monthly OLS on 24-month series
  `ALTER TABLE trade_flow_analytics ADD COLUMN IF NOT EXISTS
     monthly_ols_slope       REAL`,
  `ALTER TABLE trade_flow_analytics ADD COLUMN IF NOT EXISTS
     monthly_ols_r_squared   REAL`,
  // Sliding breakpoint scan — best monthly breakpoint (YYYYMM)
  `ALTER TABLE trade_flow_analytics ADD COLUMN IF NOT EXISTS
     monthly_breakpoint_month  INTEGER`,
  // Oversupply saturation signal
  `ALTER TABLE trade_flow_analytics ADD COLUMN IF NOT EXISTS
     import_vs_consumption_growth_gap  REAL`,
  `ALTER TABLE trade_flow_analytics ADD COLUMN IF NOT EXISTS
     oversupply_saturation_flag  BOOLEAN NOT NULL DEFAULT FALSE`,
  // Index to quickly surface saturation flags
  `CREATE INDEX IF NOT EXISTS tfa_saturation_idx
     ON trade_flow_analytics (oversupply_saturation_flag, saturation_risk_score)`,
];

for (const sql of alterations) {
  await client.query(sql);
  console.log(`✓ ${sql.split('\n')[0].trim().substring(0, 80)}`);
}

await client.end();
console.log('\nAll columns applied successfully.');
console.log('Update CLAUDE.md: run this script before using the new analytics fields.');
