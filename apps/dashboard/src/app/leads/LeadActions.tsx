'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { LeadStatus } from '@/lib/api';

const NEXT_STATUS: Partial<Record<LeadStatus, LeadStatus>> = {
  new:      'approved',
  reviewed: 'approved',
  approved: 'contacted',
};

const REJECT_STATUS: Partial<Record<LeadStatus, LeadStatus>> = {
  new:      'invalid',
  reviewed: 'invalid',
  approved: 'invalid',
};

export function LeadActions({ id, status }: { id: string; status: LeadStatus }) {
  const router = useRouter();
  const [current, setCurrent] = useState<LeadStatus>(status);
  const [loading, setLoading] = useState<'advance' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const nextStatus   = NEXT_STATUS[current];
  const rejectStatus = REJECT_STATUS[current];

  if (!nextStatus && !rejectStatus) return null;

  async function act(newStatus: LeadStatus, type: 'advance' | 'reject') {
    setLoading(type);
    setError(null);
    try {
      const res = await fetch(`/api/leads/${encodeURIComponent(id)}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setCurrent(newStatus);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setLoading(null);
    }
  }

  const advanceLabel: Record<LeadStatus, string> = {
    new:      'Approve',
    reviewed: 'Approve',
    approved: 'Mark Contacted',
    contacted: '', qualified: '', replied: '', won: '', lost: '', invalid: '',
  };

  if (['contacted', 'replied', 'qualified', 'won', 'lost', 'invalid'].includes(current)) {
    return (
      <span className={`text-xs font-medium capitalize ${
        current === 'won'       ? 'text-emerald-600' :
        current === 'invalid'   ? 'text-gray-400'    :
        current === 'contacted' ? 'text-purple-600'  : 'text-gray-500'
      }`}>
        {current}
      </span>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      {nextStatus && (
        <button
          onClick={() => act(nextStatus, 'advance')}
          disabled={loading !== null}
          className="px-2 py-0.5 rounded text-xs font-medium bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 transition-colors"
        >
          {loading === 'advance' ? '…' : advanceLabel[current] || 'Advance'}
        </button>
      )}
      {rejectStatus && (
        <button
          onClick={() => act(rejectStatus, 'reject')}
          disabled={loading !== null}
          className="px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600 hover:bg-red-50 hover:text-red-700 disabled:opacity-50 transition-colors"
        >
          {loading === 'reject' ? '…' : '✕'}
        </button>
      )}
      {error && <span className="text-xs text-red-500">{error}</span>}
    </div>
  );
}
