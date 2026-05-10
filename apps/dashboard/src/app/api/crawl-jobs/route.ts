import { NextResponse, type NextRequest } from 'next/server';

const API_BASE = process.env.API_URL        ?? 'http://localhost:3001';
const API_KEY  = process.env.API_SECRET_KEY ?? '';

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const qs = searchParams.toString();

  try {
    const res = await fetch(`${API_BASE}/api/crawl-jobs${qs ? `?${qs}` : ''}`, {
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
