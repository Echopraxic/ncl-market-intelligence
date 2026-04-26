export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function durationSeconds(
  start: string | null | undefined,
  end: string | null | undefined,
): string {
  if (!start || !end) return '—';
  const s = Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function formatDurationMs(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1_000) return `${ms}ms`;
  const s = Math.round(ms / 1_000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

export function countryFlag(code: string): string {
  const flags: Record<string, string> = {
    DE: '🇩🇪', FR: '🇫🇷', NL: '🇳🇱', GB: '🇬🇧', IE: '🇮🇪',
    ES: '🇪🇸', IT: '🇮🇹', US: '🇺🇸', CN: '🇨🇳',
  };
  return flags[code.toUpperCase()] ?? code;
}

export function sourceLabel(source: string): string {
  const labels: Record<string, string> = {
    google_trends: 'Google Trends',
    amazon_eu: 'Amazon EU',
    social: 'Social',
    retailer: 'Retailer',
    trade_data: 'Trade Data',
  };
  return labels[source] ?? source;
}

export function isoDateDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}
