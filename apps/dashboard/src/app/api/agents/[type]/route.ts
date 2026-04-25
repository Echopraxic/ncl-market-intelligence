import { NextResponse } from 'next/server';

const API_BASE = process.env.API_URL        ?? 'http://localhost:3001';
const API_KEY  = process.env.API_SECRET_KEY ?? '';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ type: string }> },
) {
  const { type } = await params;

  try {
    const res = await fetch(`${API_BASE}/api/agents/${encodeURIComponent(type)}/run`, {
      method:  'POST',
      headers: { 'x-api-key': API_KEY },
    });

    const body = await res.json().catch(() => ({}));
    return NextResponse.json(body, { status: res.status });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 502 },
    );
  }
}
