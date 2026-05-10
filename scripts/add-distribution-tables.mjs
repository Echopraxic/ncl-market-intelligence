/**
 * Migration: Phase 5 — Distribution Intelligence Tables
 * Adds new columns to distributors/leads and creates 3 new tables.
 * Safe to re-run: all statements use IF NOT EXISTS patterns.
 */
import pg from 'pg';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const statements = [
  // Extend distributors
  `ALTER TABLE distributors ADD COLUMN IF NOT EXISTS description TEXT`,
  `ALTER TABLE distributors ADD COLUMN IF NOT EXISTS contact_name TEXT`,
  `ALTER TABLE distributors ADD COLUMN IF NOT EXISTS contact_email TEXT`,
  `ALTER TABLE distributors ADD COLUMN IF NOT EXISTS linkedin_url TEXT`,
  `ALTER TABLE distributors ADD COLUMN IF NOT EXISTS discovery_source TEXT`,
  `ALTER TABLE distributors ADD COLUMN IF NOT EXISTS employee_count INTEGER`,
  `ALTER TABLE distributors ADD COLUMN IF NOT EXISTS revenue_tier TEXT`,
  `ALTER TABLE distributors ADD COLUMN IF NOT EXISTS distributor_score REAL DEFAULT 0`,
  `ALTER TABLE distributors ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'new'`,
  `ALTER TABLE distributors ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW()`,
  `CREATE UNIQUE INDEX IF NOT EXISTS distributor_name_country_uniq ON distributors (name, country_code)`,
  `CREATE INDEX IF NOT EXISTS distributor_score_idx ON distributors (distributor_score)`,

  // Extend leads
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS regulatory_risk_level TEXT`,
  `ALTER TABLE leads ADD COLUMN IF NOT EXISTS distributor_match_count INTEGER DEFAULT 0`,

  // Create distributor_buying_intent
  `CREATE TABLE IF NOT EXISTS distributor_buying_intent (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    distributor_id   UUID NOT NULL REFERENCES distributors(id) ON DELETE CASCADE,
    category         TEXT NOT NULL,
    intent_strength  REAL DEFAULT 0,
    signals          JSONB,
    source           TEXT NOT NULL,
    detected_at      TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS dbi_distributor_category_uniq ON distributor_buying_intent (distributor_id, category)`,
  `CREATE INDEX IF NOT EXISTS dbi_intent_strength_idx ON distributor_buying_intent (intent_strength, category)`,

  // Create distributor_brand_matches
  `CREATE TABLE IF NOT EXISTS distributor_brand_matches (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    distributor_id  UUID NOT NULL REFERENCES distributors(id) ON DELETE CASCADE,
    lead_id         UUID REFERENCES leads(id) ON DELETE SET NULL,
    brand_id        UUID REFERENCES brands(id) ON DELETE SET NULL,
    match_score     REAL DEFAULT 0,
    match_reasons   JSONB,
    status          TEXT NOT NULL DEFAULT 'suggested',
    created_at      TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS dbm_match_score_idx ON distributor_brand_matches (match_score)`,
  `CREATE INDEX IF NOT EXISTS dbm_lead_idx ON distributor_brand_matches (lead_id)`,
  `CREATE INDEX IF NOT EXISTS dbm_status_idx ON distributor_brand_matches (status)`,

  // Create regulatory_flags
  `CREATE TABLE IF NOT EXISTS regulatory_flags (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category          TEXT NOT NULL,
    country_code      TEXT NOT NULL,
    risk_level        TEXT NOT NULL,
    flag_type         TEXT NOT NULL,
    description       TEXT NOT NULL,
    source_regulation TEXT,
    created_at        TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS reg_flags_cat_country_flag_uniq ON regulatory_flags (category, country_code, flag_type)`,
  `CREATE INDEX IF NOT EXISTS reg_flags_risk_idx ON regulatory_flags (risk_level, category)`,
];

let ok = 0;
let fail = 0;
for (const stmt of statements) {
  try {
    await client.query(stmt);
    const label = stmt.slice(0, 60).replace(/\s+/g, ' ');
    console.log(`✓ ${label}…`);
    ok++;
  } catch (err) {
    console.error(`✗ FAILED: ${stmt.slice(0, 60)}… — ${err.message}`);
    fail++;
  }
}

await client.end();
console.log(`\n${ok} succeeded, ${fail} failed.`);
if (fail > 0) process.exit(1);
