// Adds the unique index that backs ON CONFLICT DO NOTHING in
// google-trends-crawler.ts backfillHistoricalSignals().
//
// Before running, you may want to dedupe existing rows. The `keep one` query
// below preserves the earliest-inserted row per (source, countryCode, category,
// capturedAt) and deletes the rest. Re-runs are safe — both DELETE and CREATE
// INDEX are idempotent against the IF [NOT] EXISTS clauses.

import pg from 'pg';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const dedupe = `
  DELETE FROM eu_market_signals a
  USING eu_market_signals b
  WHERE a.id < b.id
    AND a.source = b.source
    AND a.country_code = b.country_code
    AND a.category = b.category
    AND a.captured_at = b.captured_at
`;

const createIndex = `
  CREATE UNIQUE INDEX IF NOT EXISTS eu_signals_source_country_category_captured_uniq
    ON eu_market_signals (source, country_code, category, captured_at)
`;

try {
  const dedupeResult = await client.query(dedupe);
  console.log(`Removed ${dedupeResult.rowCount} duplicate rows`);
} catch (err) {
  console.error('Dedup step failed:', err.message);
}

try {
  await client.query(createIndex);
  console.log('OK: unique index created (or already existed)');
} catch (err) {
  console.error('FAIL: create index:', err.message);
  process.exitCode = 1;
}

await client.end();
console.log('Done.');
