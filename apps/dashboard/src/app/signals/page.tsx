import { getSignals } from '@/lib/api';
import { SourceBadge } from '@/components/Badge';
import { StatCard } from '@/components/StatCard';
import { countryFlag, formatDateTime, isoDateDaysAgo } from '@/lib/utils';

type SearchParams = Promise<{
  countryCode?: string;
  source?: string;
  category?: string;
  days?: string;
}>;

const COUNTRIES = ['', 'DE', 'FR', 'NL', 'GB', 'IE', 'ES', 'IT'];
const SOURCES = [
  { value: '', label: 'All sources' },
  { value: 'google_trends', label: 'Google Trends' },
  { value: 'amazon_eu', label: 'Amazon EU' },
];
const DAY_OPTIONS = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '', label: 'All time' },
];

export default async function SignalsPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const countryCode = params.countryCode ?? '';
  const source = params.source ?? '';
  const days = params.days ?? '30';

  const since = days ? isoDateDaysAgo(parseInt(days, 10)) : undefined;

  const data = await getSignals({
    ...(countryCode ? { countryCode } : {}),
    ...(source ? { source } : {}),
    ...(since ? { since } : {}),
    limit: 100,
  }).catch(() => ({ signals: [], limit: 100 }));

  // Summary stats
  const bySource = data.signals.reduce<Record<string, number>>((acc, s) => {
    acc[s.source] = (acc[s.source] ?? 0) + 1;
    return acc;
  }, {});

  const byCountry = data.signals.reduce<Record<string, number>>((acc, s) => {
    acc[s.countryCode] = (acc[s.countryCode] ?? 0) + 1;
    return acc;
  }, {});

  const topCountry = Object.entries(byCountry).sort((a, b) => b[1] - a[1])[0];

  function filterUrl(updates: Record<string, string>) {
    const merged = { countryCode, source, days, ...updates };
    const q = new URLSearchParams(
      Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== '')),
    ).toString();
    return `/signals${q ? `?${q}` : ''}`;
  }

  return (
    <div className="p-8 max-w-6xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-navy-900">Market Signals</h1>
        <p className="text-gray-500 mt-1 text-sm">
          Trend and demand data captured from Google Trends and Amazon EU
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard label="Signals shown" value={data.signals.length} sub={days ? `last ${days} days` : 'all time'} />
        <StatCard label="Google Trends" value={bySource.google_trends ?? 0} />
        <StatCard label="Amazon EU" value={bySource.amazon_eu ?? 0} />
        <StatCard label="Top country" value={topCountry ? `${countryFlag(topCountry[0])} ${topCountry[0]}` : '—'} sub={topCountry ? `${topCountry[1]} signals` : ''} />
      </div>

      {/* Filters */}
      <div className="bg-white rounded-lg border shadow-sm p-4 mb-6 flex flex-wrap items-center gap-6">
        {/* Country */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 font-medium">Country:</span>
          <div className="flex gap-1">
            {COUNTRIES.map((cc) => (
              <a
                key={cc}
                href={filterUrl({ countryCode: cc })}
                className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                  countryCode === cc
                    ? 'bg-navy-900 text-white border-navy-900'
                    : 'bg-white text-gray-600 border-gray-300 hover:border-navy-900'
                }`}
              >
                {cc ? `${countryFlag(cc)} ${cc}` : 'All'}
              </a>
            ))}
          </div>
        </div>

        {/* Source */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 font-medium">Source:</span>
          <div className="flex gap-1">
            {SOURCES.map(({ value, label }) => (
              <a
                key={value}
                href={filterUrl({ source: value })}
                className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                  source === value
                    ? 'bg-navy-900 text-white border-navy-900'
                    : 'bg-white text-gray-600 border-gray-300 hover:border-navy-900'
                }`}
              >
                {label}
              </a>
            ))}
          </div>
        </div>

        {/* Time range */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 font-medium">Period:</span>
          <div className="flex gap-1">
            {DAY_OPTIONS.map(({ value, label }) => (
              <a
                key={value}
                href={filterUrl({ days: value })}
                className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                  days === value
                    ? 'bg-navy-900 text-white border-navy-900'
                    : 'bg-white text-gray-600 border-gray-300 hover:border-navy-900'
                }`}
              >
                {label}
              </a>
            ))}
          </div>
        </div>
      </div>

      {/* Signals table */}
      <div className="bg-white rounded-lg border shadow-sm overflow-hidden">
        {data.signals.length === 0 ? (
          <div className="py-16 text-center text-gray-400 text-sm">
            No signals captured yet. Run the Google Trends or Amazon EU crawler to populate data.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50">
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Country</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Category</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Source</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Type</th>
                <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase">Value</th>
                <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase">Captured</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {data.signals.map((sig) => (
                <tr key={sig.id} className="hover:bg-gray-50">
                  <td className="px-6 py-3 font-medium">
                    {countryFlag(sig.countryCode)} {sig.countryCode}
                  </td>
                  <td className="px-6 py-3 text-gray-700 max-w-xs truncate">{sig.category}</td>
                  <td className="px-6 py-3"><SourceBadge source={sig.source} /></td>
                  <td className="px-6 py-3 text-gray-500 capitalize">{sig.signalType}</td>
                  <td className="px-6 py-3 text-right font-mono text-gray-700">
                    {sig.signalValue.toFixed(1)}
                  </td>
                  <td className="px-6 py-3 text-right text-gray-400 text-xs">
                    {formatDateTime(sig.capturedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
