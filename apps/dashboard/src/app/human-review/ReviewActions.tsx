'use client';

import { useState, useEffect, useRef } from 'react';

type BtnState = 'idle' | 'loading' | 'running' | 'done' | 'error';

function ActionButton({
  onClick,
  idleLabel,
  idleClass,
}: {
  onClick: () => Promise<void>;
  idleLabel: string;
  idleClass: string;
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

  const label =
    state === 'loading' ? 'Starting…'
    : state === 'running'  ? `Running ${elapsed}s`
    : state === 'done'     ? 'Done ✓'
    : state === 'error'    ? 'Failed ✗'
    : idleLabel;

  const colours =
    state === 'loading' ? 'bg-gray-400 text-white'
    : state === 'running'  ? 'bg-amber-500 text-white'
    : state === 'done'     ? 'bg-green-600 text-white'
    : state === 'error'    ? 'bg-red-600 text-white'
    : idleClass;

  return (
    <button
      onClick={handle}
      disabled={state !== 'idle'}
      className={`px-2.5 py-1 rounded text-xs font-medium transition-colors disabled:cursor-not-allowed ${colours}`}
    >
      {label}
    </button>
  );
}

export function ReviewActions({ id, status }: { id: string; status: string }) {
  const [current, setCurrent] = useState(status);
  const [error, setError] = useState<string | null>(null);

  if (current !== 'pending') {
    return (
      <span className={`text-xs font-medium ${current === 'approved' ? 'text-green-600' : 'text-red-600'}`}>
        {current === 'approved' ? 'Approved' : 'Rejected'}
      </span>
    );
  }

  async function act(action: 'approve' | 'reject') {
    setError(null);
    const res = await fetch(`/api/human-review/${encodeURIComponent(id)}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ status: action === 'approve' ? 'approved' : 'rejected' }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setCurrent(action === 'approve' ? 'approved' : 'rejected');
  }

  return (
    <div className="flex items-center gap-2">
      <ActionButton
        onClick={() => act('approve')}
        idleLabel="Approve"
        idleClass="bg-green-600 text-white hover:bg-green-700"
      />
      <ActionButton
        onClick={() => act('reject')}
        idleLabel="Reject"
        idleClass="bg-red-600 text-white hover:bg-red-700"
      />
      {error && <span className="text-xs text-red-500">{error}</span>}
    </div>
  );
}
