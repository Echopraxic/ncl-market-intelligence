// Applies schema changes for competitor intelligence:
//   - adds sub_category to leads
//   - adds competitor_proximity + competitor_count to distributor_brand_matches
//   - creates distributor_brand_portfolio table
import pg from 'pg';
const { Client } = pg;

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  await client.query(`
    ALTER TABLE leads
      ADD COLUMN IF NOT EXISTS sub_category text;
  `);
  console.log('✓ leads.sub_category');

  await client.query(`
    ALTER TABLE distributor_brand_matches
      ADD COLUMN IF NOT EXISTS competitor_proximity text,
      ADD COLUMN IF NOT EXISTS competitor_count     integer NOT NULL DEFAULT 0;
  `);
  console.log('✓ distributor_brand_matches.competitor_proximity / competitor_count');

  await client.query(`
    CREATE TABLE IF NOT EXISTS distributor_brand_portfolio (
      id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      distributor_id   uuid        NOT NULL REFERENCES distributors(id) ON DELETE CASCADE,
      brand_name       text        NOT NULL,
      brand_website_url text,
      category_hint    text,
      sub_category_hint text,
      source           text        NOT NULL,
      confidence       real        NOT NULL DEFAULT 0.5,
      detected_at      timestamptz NOT NULL DEFAULT now()
    );
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS dbp_distributor_brand_uniq
      ON distributor_brand_portfolio(distributor_id, brand_name);
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS dbp_distributor_idx
      ON distributor_brand_portfolio(distributor_id);
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS dbp_sub_category_idx
      ON distributor_brand_portfolio(sub_category_hint);
  `);
  console.log('✓ distributor_brand_portfolio table + indexes');

  console.log('\nAll competitor intel schema changes applied successfully.');
} catch (err) {
  console.error('Error:', err.message);
  process.exit(1);
} finally {
  await client.end();
}
