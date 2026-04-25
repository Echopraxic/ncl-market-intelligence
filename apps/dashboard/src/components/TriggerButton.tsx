'use client';

import { useState } from 'react';

type Props =
  | { crawlerType: string; agentType?: never; label?: never }
  | { agentType: string; label?: string; crawlerType?: never };

export function TriggerButton({ crawlerType, agentType, label }: Props) {
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');

  const idleLabel = label ?? 'Run now';

  async function trigger() {
    setState('loading');
    try {
      const url = crawlerType
        ? `/api/trigger/${encodeURIComponent(crawlerType)}`
        : `/api/agents/${encodeURIComponent(agentType!)}`;
      const res = await fetch(url, { method: 'POST' });
      setState(res.ok ? 'done' : 'error');
    } catch {
      setState('error');
    }
    setTimeout(() => setState('idle'), 3000);
  }

  const labels = { idle: idleLabel, loading: 'Queuing…', done: 'Queued ✓', error: 'Failed ✗' };
  const classes = {
    idle:    'bg-navy-900 text-white hover:bg-navy-800',
    loading: 'bg-gray-400 text-white cursor-not-allowed',
    done:    'bg-green-600 text-white',
    error:   'bg-red-600 text-white',
  };

  return (
    <button
      onClick={trigger}
      disabled={state === 'loading'}
      className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${classes[state]}`}
    >
      {labels[state]}
    </button>
  );
}
