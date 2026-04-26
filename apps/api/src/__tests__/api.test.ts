/**
 * Integration tests for all NCL MIE API endpoints.
 *
 * Uses Fastify's inject() — no real HTTP port needed.
 * Runs against the real dev database; asserts shape not content,
 * so tests pass whether the DB is empty or populated.
 *
 * DB-dependent tests are automatically skipped when the database is
 * unreachable (wrong credentials, server not running, etc.) so the
 * auth/validation tests always give a clean green result.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer } from '../api/server.js';
import { db } from '../db/index.js';
import { sql } from 'drizzle-orm';
import { Webhook } from 'svix';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

type App = Awaited<ReturnType<typeof buildServer>>;

let app: App;
let dbAvailable = false;
const KEY = process.env.API_SECRET_KEY!;
const auth = { 'x-api-key': KEY } as const;

/** Only run the test when the dev database is reachable. */
const dbTest = (name: string, fn: () => Promise<void>) =>
  it(dbAvailable ? name : `[DB unavailable — skipped] ${name}`, async () => {
    if (!dbAvailable) return;
    await fn();
  });

beforeAll(async () => {
  // Probe DB before building the server so we can skip tests cleanly.
  try {
    await db.execute(sql`SELECT 1`);
    dbAvailable = true;
  } catch {
    console.warn('\n⚠  Database unreachable — DB-dependent tests will be skipped.');
    console.warn('   See README or CLAUDE.md for setup instructions.\n');
  }
  // No scheduler — keeps tests Redis-free; trigger endpoint returns 503
  app = await buildServer();
});

afterAll(async () => {
  await app.close();
});

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------

describe('GET /health', () => {
  it('returns 200 without authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });

  it('returns expected shape', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = res.json<{ status: string; timestamp: string; service: string }>();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('ncl-mie-api');
    expect(new Date(body.timestamp).getTime()).not.toBeNaN();
  });
});

// ---------------------------------------------------------------------------
// Authentication middleware
// ---------------------------------------------------------------------------

describe('Authentication', () => {
  it('returns 401 with no API key', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/brands' });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('INVALID_API_KEY');
  });

  it('returns 401 with wrong API key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/brands',
      headers: { 'x-api-key': 'bad-key' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 for unknown routes (not 401)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/does-not-exist',
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// GET /api/brands
// ---------------------------------------------------------------------------

describe('GET /api/brands', () => {
  dbTest('returns 200 with brands array and pagination meta', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/brands', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ brands: unknown[]; limit: number; offset: number }>();
    expect(Array.isArray(body.brands)).toBe(true);
    expect(typeof body.limit).toBe('number');
    expect(typeof body.offset).toBe('number');
  });

  dbTest('respects limit param', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/brands?limit=5',
      headers: auth,
    });
    const body = res.json<{ brands: unknown[] }>();
    expect(body.brands.length).toBeLessThanOrEqual(5);
  });

  dbTest('respects offset param (pagination)', async () => {
    const [page1, page2] = await Promise.all([
      app.inject({ method: 'GET', url: '/api/brands?limit=5&offset=0', headers: auth }),
      app.inject({ method: 'GET', url: '/api/brands?limit=5&offset=5', headers: auth }),
    ]);
    expect(page1.statusCode).toBe(200);
    expect(page2.statusCode).toBe(200);
  });

  dbTest('filters by euPresence=false', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/brands?euPresence=false',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ brands: Array<{ euPresence: boolean | null }> }>();
    for (const brand of body.brands) {
      expect(brand.euPresence).toBeFalsy();
    }
  });

  dbTest('filters by euPresence=true', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/brands?euPresence=true',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ brands: Array<{ euPresence: boolean }> }>();
    for (const brand of body.brands) {
      expect(brand.euPresence).toBe(true);
    }
  });

  it('rejects invalid euPresence value with 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/brands?euPresence=maybe',
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it('rejects limit > 100 with 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/brands?limit=999',
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
  });

  dbTest('each brand has required fields', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/brands?limit=3', headers: auth });
    const body = res.json<{ brands: Array<{ id: string; name: string; country: string }> }>();
    for (const brand of body.brands) {
      expect(typeof brand.id).toBe('string');
      expect(typeof brand.name).toBe('string');
      expect(typeof brand.country).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// GET /api/signals
// ---------------------------------------------------------------------------

describe('GET /api/signals', () => {
  dbTest('returns 200 with signals array', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/signals', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ signals: unknown[]; limit: number }>();
    expect(Array.isArray(body.signals)).toBe(true);
    expect(typeof body.limit).toBe('number');
  });

  dbTest('filters by countryCode=DE', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/signals?countryCode=DE',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ signals: Array<{ countryCode: string }> }>();
    for (const sig of body.signals) {
      expect(sig.countryCode).toBe('DE');
    }
  });

  dbTest('filters by source=google_trends', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/signals?source=google_trends',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ signals: Array<{ source: string }> }>();
    for (const sig of body.signals) {
      expect(sig.source).toBe('google_trends');
    }
  });

  it('rejects invalid source with 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/signals?source=tiktok',
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
  });

  it('rejects countryCode longer than 2 chars with 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/signals?countryCode=DEU',
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
  });

  dbTest('accepts a valid since ISO date', async () => {
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const res = await app.inject({
      method: 'GET',
      url: `/api/signals?since=${encodeURIComponent(since)}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a non-ISO since value with 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/signals?since=yesterday',
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
  });

  dbTest('respects limit param', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/signals?limit=10',
      headers: auth,
    });
    const body = res.json<{ signals: unknown[] }>();
    expect(body.signals.length).toBeLessThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// GET /api/trade-shows
// ---------------------------------------------------------------------------

describe('GET /api/trade-shows', () => {
  dbTest('returns 200 with shows array', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/trade-shows', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ shows: unknown[] }>();
    expect(Array.isArray(body.shows)).toBe(true);
  });

  dbTest('defaults to upcoming=true (only future shows)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/trade-shows', headers: auth });
    const body = res.json<{ shows: Array<{ startDate: string | null }> }>();
    const now = new Date();
    for (const show of body.shows) {
      if (show.startDate) {
        expect(new Date(show.startDate).getTime()).toBeGreaterThanOrEqual(now.getTime() - 60_000);
      }
    }
  });

  dbTest('returns all shows with upcoming=false', async () => {
    const [upcoming, all] = await Promise.all([
      app.inject({ method: 'GET', url: '/api/trade-shows?upcoming=true', headers: auth }),
      app.inject({ method: 'GET', url: '/api/trade-shows?upcoming=false', headers: auth }),
    ]);
    const upcomingCount = upcoming.json<{ shows: unknown[] }>().shows.length;
    const allCount = all.json<{ shows: unknown[] }>().shows.length;
    expect(allCount).toBeGreaterThanOrEqual(upcomingCount);
  });

  dbTest('each show has exhibitorCount field', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/trade-shows?upcoming=false',
      headers: auth,
    });
    const body = res.json<{ shows: Array<{ exhibitorCount: number }> }>();
    for (const show of body.shows) {
      expect(typeof show.exhibitorCount).toBe('number');
    }
  });

  dbTest('withExhibitors=true hydrates exhibitors array', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/trade-shows?upcoming=false&withExhibitors=true',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ shows: Array<{ exhibitors: unknown[] }> }>();
    for (const show of body.shows) {
      expect(Array.isArray(show.exhibitors)).toBe(true);
    }
  });

  it('rejects invalid upcoming value with 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/trade-shows?upcoming=yes',
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /api/crawl-jobs
// ---------------------------------------------------------------------------

describe('GET /api/crawl-jobs', () => {
  dbTest('returns 200 with jobs array', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/crawl-jobs', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ jobs: unknown[] }>();
    expect(Array.isArray(body.jobs)).toBe(true);
  });

  dbTest('filters by crawlerType', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/crawl-jobs?crawlerType=shopify-brand',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ jobs: Array<{ crawlerType: string }> }>();
    for (const job of body.jobs) {
      expect(job.crawlerType).toBe('shopify-brand');
    }
  });

  dbTest('respects limit param', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/crawl-jobs?limit=3',
      headers: auth,
    });
    const body = res.json<{ jobs: unknown[] }>();
    expect(body.jobs.length).toBeLessThanOrEqual(3);
  });

  it('rejects limit=0 with 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/crawl-jobs?limit=0',
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
  });

  dbTest('each job has required fields', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/crawl-jobs?limit=5',
      headers: auth,
    });
    const body = res.json<{ jobs: Array<{ id: string; crawlerType: string; status: string }> }>();
    for (const job of body.jobs) {
      expect(typeof job.id).toBe('string');
      expect(typeof job.crawlerType).toBe('string');
      expect(['pending', 'running', 'completed', 'failed']).toContain(job.status);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /api/crawlers
// ---------------------------------------------------------------------------

describe('GET /api/crawlers', () => {
  dbTest('returns 200 with registered array and recentJobs array', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/crawlers', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ registered: string[]; recentJobs: unknown[] }>();
    expect(Array.isArray(body.registered)).toBe(true);
    expect(Array.isArray(body.recentJobs)).toBe(true);
  });

  dbTest('returns empty registered list when no scheduler injected', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/crawlers', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ registered: string[] }>();
    // No scheduler was passed to buildServer() in tests
    expect(body.registered).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// POST /api/crawlers/:type/trigger
// ---------------------------------------------------------------------------

describe('POST /api/crawlers/:type/trigger', () => {
  it('returns 503 when no scheduler is available', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/crawlers/shopify-brand/trigger',
      headers: auth,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('NO_SCHEDULER');
  });

  it('requires authentication', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/crawlers/shopify-brand/trigger',
    });
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// D5 — POST /api/webhooks/resend — svix signature verification
//
// When RESEND_WEBHOOK_SECRET is set, the server must:
//   • Accept requests with a valid svix HMAC signature  → 200
//   • Reject requests with an invalid signature          → 401 INVALID_SIGNATURE
//   • Reject requests with missing svix headers          → 401 MISSING_SIGNATURE
//
// When the secret is not set the server accepts all requests (dev mode).
// ---------------------------------------------------------------------------

const WEBHOOK_SECRET = 'whsec_' + Buffer.from('test-webhook-secret-d5').toString('base64');
const WEBHOOK_PAYLOAD = JSON.stringify({ type: 'email.opened', data: { message_id: 'msg_test_d5' } });

function signWebhookPayload(msgId: string, ts: Date, payload: string): string {
  const wh = new Webhook(WEBHOOK_SECRET);
  return wh.sign(msgId, ts, payload);
}

describe('D5 — POST /api/webhooks/resend — signature verification', () => {
  const originalSecret = process.env.RESEND_WEBHOOK_SECRET;

  beforeAll(() => {
    // Enable signature verification for this suite
    process.env.RESEND_WEBHOOK_SECRET = WEBHOOK_SECRET;
  });

  afterAll(() => {
    // Restore original value (undefined in most test environments)
    if (originalSecret === undefined) {
      delete process.env.RESEND_WEBHOOK_SECRET;
    } else {
      process.env.RESEND_WEBHOOK_SECRET = originalSecret;
    }
  });

  it('returns 200 when the svix HMAC signature is valid', async () => {
    const msgId = 'msg_valid_d5';
    const ts = new Date();
    const sig = signWebhookPayload(msgId, ts, WEBHOOK_PAYLOAD);

    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/resend',
      headers: {
        'content-type': 'application/json',
        'svix-id': msgId,
        'svix-timestamp': String(Math.floor(ts.getTime() / 1000)),
        'svix-signature': sig,
      },
      payload: WEBHOOK_PAYLOAD,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().received).toBe(true);
  });

  it('returns 401 INVALID_SIGNATURE when the signature is wrong', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/resend',
      headers: {
        'content-type': 'application/json',
        'svix-id': 'msg_bad_d5',
        'svix-timestamp': String(Math.floor(Date.now() / 1000)),
        'svix-signature': 'v1,dGhpcyBpcyBub3QgYSB2YWxpZCBzaWduYXR1cmU=', // bogus
      },
      payload: WEBHOOK_PAYLOAD,
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('INVALID_SIGNATURE');
  });

  it('returns 401 MISSING_SIGNATURE when svix headers are absent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/resend',
      headers: { 'content-type': 'application/json' },
      payload: WEBHOOK_PAYLOAD,
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('MISSING_SIGNATURE');
  });

  it('returns 200 without signature verification when secret is not configured', async () => {
    // Temporarily remove the secret
    delete process.env.RESEND_WEBHOOK_SECRET;

    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/resend',
      headers: { 'content-type': 'application/json' },
      payload: WEBHOOK_PAYLOAD,
    });

    expect(res.statusCode).toBe(200);

    // Restore for subsequent tests
    process.env.RESEND_WEBHOOK_SECRET = WEBHOOK_SECRET;
  });
});
