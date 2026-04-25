import { defineConfig } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = (p: string) => path.resolve(__dirname, 'src', p);

// ---------------------------------------------------------------------------
// Load root .env so DATABASE_URL etc. are available during tests without
// requiring dotenv as a dependency.
// ---------------------------------------------------------------------------
function loadDotEnv(filePath: string): Record<string, string> {
  const vars: Record<string, string> = {};
  try {
    const lines = readFileSync(filePath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      vars[key] = val;
    }
  } catch {
    // .env not found — rely on process.env already being set
  }
  return vars;
}

const rootEnv = loadDotEnv(path.resolve(__dirname, '../../.env'));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true }, // share DB connection pool across tests
    },
    testTimeout: 20_000,
    hookTimeout: 20_000,
    env: {
      DATABASE_URL: rootEnv.DATABASE_URL ?? 'postgresql://ncl_user:ncl_password@localhost:5432/ncl_mie',
      REDIS_URL:    rootEnv.REDIS_URL    ?? 'redis://localhost:6379',
      API_SECRET_KEY: rootEnv.API_SECRET_KEY ?? 'change-me-in-production',
      NODE_ENV: 'test',
    },
  },
  resolve: {
    alias: [
      // Handle bare @/db alias
      { find: /^@\/db$/, replacement: src('db/index.ts') },
      // Handle @/db/... with and without .js extension
      { find: /^@\/db\/(.+?)(?:\.js)?$/, replacement: src('db/$1.ts') },
      // Handle @/lib/... @/agents/... @/api/... @/config/...
      { find: /^@\/(lib|agents|api|config)\/(.+?)(?:\.js)?$/, replacement: `${src('$1/$2')}.ts` },
    ],
  },
});
