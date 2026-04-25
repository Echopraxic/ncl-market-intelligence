import { NextResponse } from 'next/server';

const API_BASE = process.env.API_URL        ?? 'http://localhost:3001';
const API_KEY  = process.env.API_SECRET_KEY ?? '';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body   = await request.json().catch(() => ({}));

  try {
    const res = await fetch(`${API_BASE}/api/human-review/${encodeURIComponent(id)}`, {
      method:  'PATCH',
      headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });

    const json = await res.json().catch(() => ({}));
    return NextResponse.json(json, { status: res.status });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 502 },
    );
  }
}
