// Minimal migration runner for pgvector extension setup.
// Full schema is managed via Drizzle ORM (`npm run db:push`).
// This file enables pgvector on startup (if available) but delegates
// table/index creation to Drizzle.

import pg from 'pg';

const { Pool } = pg;

export async function runMigrations(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();

  try {
    console.log('[migrate] Ensuring database extensions…');

    // Enable uuid-ossp
    await client.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`);

    // Enable pgvector (silently fail if unavailable — optional for now)
    try {
      await client.query(`CREATE EXTENSION IF NOT EXISTS "pgvector";`);
    } catch (err: any) {
      if (!err.message?.includes('is not available')) throw err;
      console.log('[migrate] Note: pgvector not available (optional)');
    }

    console.log('[migrate] Extensions ready ✓');
    console.log('[migrate] Schema is managed via Drizzle ORM (npm run db:push)');
  } finally {
    client.release();
    await pool.end();
  }
}
