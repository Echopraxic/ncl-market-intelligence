'use client';

import { useState, useEffect, useRef } from 'react';

type Props =
  | { crawlerType: string; agentType?: never; label?: never }
  | { agentType: string; label?: string; crawlerType?: never };

export function TriggerButton({ crawlerType, agentType, label }: Props) {
  const [state, setState] = useState<'idle' | 'loading' | 'running' | 'done' | 'error'>('idle');
  const [elapsed, setElapsed] = useState(0);
  const intervalRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollRef       = useRef<ReturnType<typeof setInterval> | null>(null);
  const triggerTimeRef = useRef<number>(0);

  // Elapsed-seconds ticker while running
  useEffect(() => {
    if (state === 'running') {
      setElapsed(0);
      intervalRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
    } else {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [state]);

  // Clean up poll on unmount
  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  const idleLabel = label ?? 'Run now';

  function markDone() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    setState('done');
    setTimeout(() => setState((s) => s === 'done' ? 'idle' : s), 3000);
  }

  function markError() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    setState('error');
    setTimeout(() => setState((s) => s === 'error' ? 'idle' : s), 3000);
  }

  /** Poll /api/crawl-jobs until the crawler's latest job completes. */
  function startPolling(type: string) {
    if (pollRef.current) clearInterval(pollRef.current);

    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/crawl-jobs?crawlerType=${encodeURIComponent(type)}&limit=1`);
        if (!res.ok) return;
        const data = await res.json() as { jobs?: Array<{ status: string; completedAt: string | null; startedAt: string }> };
        const job = data.jobs?.[0];
        if (!job) return;

        // Only react to a job that started after we triggered it
        const jobStarted = new Date(job.startedAt).getTime();
        if (jobStarted < triggerTimeRef.current - 5000) return;

        if (job.status === 'completed') { markDone(); }
        if (job.status === 'failed')    { markError(); }
      } catch { /* poll silently */ }
    }, 5000);
  }

  async function trigger() {
    setState('loading');
    triggerTimeRef.current = Date.now();

    try {
      const url = crawlerType
        ? `/api/trigger/${encodeURIComponent(crawlerType)}`
        : `/api/agents/${encodeURIComponent(agentType!)}`;
      const res = await fetch(url, { method: 'POST' });

      if (!res.ok) {
        markError();
        return;
      }

      setState('running');

      if (crawlerType) {
        // Crawlers write to crawl_jobs — poll for actual completion
        startPolling(crawlerType);
        // Safety fallback: auto-complete after 1000s
        setTimeout(() => {
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
          setState((s) => s === 'running' ? 'done' : s);
          setTimeout(() => setState((s) => s === 'done' ? 'idle' : s), 3000);
        }, 1_000_000);
      } else {
        // Agents are fire-and-forget — no completion signal; count up to 1000s
        setTimeout(() => setState((s) => s === 'running' ? 'done' : s), 1_000_000);
        setTimeout(() => setState((s) => s === 'done' ? 'idle' : s), 1_003_000);
      }
    } catch {
      markError();
    }
  }

  const labels: Record<string, string> = {
    idle:    idleLabel,
    loading: 'Starting…',
    running: `Running ${elapsed}s`,
    done:    'Done ✓',
    error:   'Failed ✗',
  };
  const classes: Record<string, string> = {
    idle:    'bg-navy-900 text-white hover:bg-navy-800',
    loading: 'bg-gray-400 text-white cursor-not-allowed',
    running: 'bg-amber-500 text-white cursor-not-allowed',
    done:    'bg-green-600 text-white',
    error:   'bg-red-600 text-white',
  };

  return (
    <button
      onClick={state === 'idle' ? trigger : undefined}
      disabled={state === 'loading' || state === 'running'}
      className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${classes[state]}`}
    >
      {labels[state]}
    </button>
  );
}
