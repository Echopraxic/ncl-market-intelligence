'use client';

import { useState, useEffect, useRef } from 'react';
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

type BtnState = 'idle' | 'loading' | 'running' | 'done' | 'error';

function ActionButton({
  onClick,
  disabled,
  variant,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  variant: 'advance' | 'reject';
  children: React.ReactNode;
}) {
  const [state, setState] = useState<BtnState>('idle');
  const [elapsed, setElapsed] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (state === 'running') {
      setElapsed(0);
      intervalRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [state]);

  async function handle() {
    if (state !== 'idle') return;
    setState('loading');
    try {
      setState('running');
      await onClick();
      setState('done');
      setTimeout(() => setState('idle'), 3000);
    } catch {
      setState('error');
      setTimeout(() => setState('idle'), 3000);
    }
  }

  const label = state === 'loading' ? 'Starting…'
    : state === 'running'  ? `Running ${elapsed}s`
    : state === 'done'     ? 'Done ✓'
    : state === 'error'    ? 'Failed ✗'
    : children;

  const base = 'px-2 py-0.5 rounded text-xs font-medium transition-colors disabled:cursor-not-allowed';
  const colours =
    state === 'loading' ? 'bg-gray-400 text-white'
    : state === 'running'  ? 'bg-amber-500 text-white'
    : state === 'done'     ? 'bg-green-600 text-white'
    : state === 'error'    ? 'bg-red-600 text-white'
    : variant === 'advance'
      ? 'bg-green-600 text-white hover:bg-green-700'
      : 'bg-gray-100 text-gray-600 hover:bg-red-50 hover:text-red-700';

  return (
    <button onClick={handle} disabled={disabled || state !== 'idle'} className={`${base} ${colours}`}>
      {label as React.ReactNode}
    </button>
  );
}

export function LeadActions({ id, status }: { id: string; status: LeadStatus }) {
  const router = useRouter();
  const [current, setCurrent] = useState<LeadStatus>(status);
  const [error, setError] = useState<string | null>(null);

  const nextStatus   = NEXT_STATUS[current];
  const rejectStatus = REJECT_STATUS[current];

  if (!nextStatus && !rejectStatus) return null;

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

  async function act(newStatus: LeadStatus) {
    setError(null);
    const res = await fetch(`/api/leads/${encodeURIComponent(id)}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ status: newStatus }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setCurrent(newStatus);
    router.refresh();
  }

  const advanceLabel: Record<LeadStatus, string> = {
    new: 'Approve', reviewed: 'Approve', approved: 'Mark Contacted',
    contacted: '', qualified: '', replied: '', won: '', lost: '', invalid: '',
  };

  return (
    <div className="flex items-center gap-1.5">
      {nextStatus && (
        <ActionButton variant="advance" disabled={false} onClick={() => act(nextStatus)}>
          {advanceLabel[current] || 'Advance'}
        </ActionButton>
      )}
      {rejectStatus && (
        <ActionButton variant="reject" disabled={false} onClick={() => act(rejectStatus)}>
          ✕
        </ActionButton>
      )}
      {error && <span className="text-xs text-red-500">{error}</span>}
    </div>
  );
}
