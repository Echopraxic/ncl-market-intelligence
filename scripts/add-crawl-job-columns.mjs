import pg from 'pg';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const statements = [
  `ALTER TABLE crawl_jobs ADD COLUMN IF NOT EXISTS pages_crawled integer`,
  `ALTER TABLE crawl_jobs ADD COLUMN IF NOT EXISTS duration_ms integer`,
  `ALTER TABLE crawl_jobs ADD COLUMN IF NOT EXISTS last_fresh_at timestamp`,
  `ALTER TABLE crawl_jobs ADD COLUMN IF NOT EXISTS error_details jsonb`,
];

for (const sql of statements) {
  try {
    await client.query(sql);
    console.log('OK:', sql);
  } catch (err) {
    console.error('FAIL:', sql, err.message);
  }
}

await client.end();
console.log('Done.');
