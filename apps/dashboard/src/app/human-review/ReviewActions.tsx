'use client';

import { useState } from 'react';

export function ReviewActions({ id, status }: { id: string; status: string }) {
  const [current, setCurrent] = useState(status);
  const [loading, setLoading] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (current !== 'pending') {
    return (
      <span className={`text-xs font-medium ${current === 'approved' ? 'text-green-600' : 'text-red-600'}`}>
        {current === 'approved' ? 'Approved' : 'Rejected'}
      </span>
    );
  }

  async function act(action: 'approve' | 'reject') {
    setLoading(action);
    setError(null);
    try {
      const res = await fetch(`/api/human-review/${encodeURIComponent(id)}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ status: action === 'approve' ? 'approved' : 'rejected' }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setCurrent(action === 'approve' ? 'approved' : 'rejected');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => act('approve')}
        disabled={loading !== null}
        className="px-2.5 py-1 rounded text-xs font-medium bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 transition-colors"
      >
        {loading === 'approve' ? '…' : 'Approve'}
      </button>
      <button
        onClick={() => act('reject')}
        disabled={loading !== null}
        className="px-2.5 py-1 rounded text-xs font-medium bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
      >
        {loading === 'reject' ? '…' : 'Reject'}
      </button>
      {error && <span className="text-xs text-red-500">{error}</span>}
    </div>
  );
}
