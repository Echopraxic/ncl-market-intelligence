import { getTrends } from '@/lib/api';
import { TierBadge, Badge } from '@/components/Badge';
import { StatCard } from '@/components/StatCard';
import { TriggerButton } from '@/components/TriggerButton';
import { countryFlag, relativeTime } from '@/lib/utils';
import type { OpportunityTier } from '@/lib/api';
import Link from 'next/link';

type SearchParams = Promise<{
  countryCode?: string;
  category?: string;
  tier?: string;
  status?: string;
}>;

const COUNTRIES   = ['', 'DE', 'FR', 'NL', 'GB', 'ES', 'IT'];
const CATEGORIES  = ['', 'food_beverage', 'supplements', 'cosmetics_personal_care', 'home_goods', 'toys_games'];
const TIERS       = ['', 'breakthrough', 'accelerating', 'sustained', 'mature', 'disrupted', 'watch'];
const STATUSES    = [{ value: '', label: 'All' }, { value: 'detected', label: 'Detected' }, { value: 'published', label: 'Published' }];

const TIER_DESCRIPTIONS: Record<string, string> = {
  breakthrough: '>50% YoY — first-mover window',
  accelerating: '25–50% — proven demand',
  sustained:    '10–25% — established market',
  mature:       '5–10% — niche focus',
  disrupted:    '<0% — structural vacuum',
  watch:        'Volatile / noisy — monitor only',
};

function categoryLabel(c: string) {
  return c.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) || 'All';
}

export default async function TrendsPage({ searchParams }: { searchParams: SearchParams }) {
  const params  = await searchParams;
  const country  = params.countryCode ?? '';
  const category = params.category    ?? '';
  const tier     = params.tier        ?? '';
  const status   = params.status      ?? '';

  const data = await getTrends({
    ...(country  ? { countryCode: country }        : {}),
    ...(category ? { category }                    : {}),
    ...(tier     ? { tier: tier as OpportunityTier } : {}),
    ...(status   ? { status }                      : {}),
    limit: 100,
  }).catch(() => ({ trends: [], limit: 100 }));

  const trends = data.trends;

  // Summary stats
  const byTier = trends.reduce<Record<string, number>>((acc, t) => {
    const k = t.opportunityTier ?? 'unknown';
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});

  const acceleratingCount = trends.filter(t => t.isAccelerating).length;
  const avgConfidence = trends.length
    ? (trends.reduce((s, t) => s + t.confidence, 0) / trends.length * 100).toFixed(0)
    : '—';

  function filterUrl(updates: Record<string, string>) {
    const merged = { countryCode: country, category, tier, status, ...updates };
    const q = new URLSearchParams(
      Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== '')),
    ).toString();
    return `/trends${q ? `?${q}` : ''}`;
  }

  return (
    <div className="p-8 max-w-6xl">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-navy-900">Detected Trends</h1>
          <p className="text-gray-500 mt-1 text-sm">
            Statistical trend detection across EU category × country pairs
          </p>
        </div>
        <TriggerButton agentType="trends" label="Run Detection" />
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard label="Trends found" value={trends.length} sub="matching filters" />
        <StatCard label="Accelerating" value={acceleratingCount} sub="momentum increasing" />
        <StatCard label="Avg confidence" value={trends.length ? `${avgConfidence}%` : '—'} sub="across results" />
        <StatCard label="Breakthrough" value={byTier.breakthrough ?? 0} sub=">50% YoY growth" />
      </div>

      {/* Tier legend */}
      {tier === '' && (
        <div className="bg-white rounded-lg border shadow-sm p-4 mb-6">
          <p className="text-xs font-medium text-gray-500 uppercase mb-3">Opportunity Tier Guide</p>
          <div className="flex flex-wrap gap-4">
            {TIERS.filter(t => t !== '').map(t => (
              <a key={t} href={filterUrl({ tier: t })} className="flex items-center gap-2 hover:opacity-80">
                <TierBadge tier={t} />
                <span className="text-xs text-gray-500">{TIER_DESCRIPTIONS[t]}</span>
              </a>
            ))}
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="bg-white rounded-lg border shadow-sm p-4 mb-6 flex flex-wrap items-center gap-6">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 font-medium">Country:</span>
          <div className="flex gap-1 flex-wrap">
            {COUNTRIES.map(cc => (
              <a key={cc} href={filterUrl({ countryCode: cc })}
                className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                  country === cc
                    ? 'bg-navy-900 text-white border-navy-900'
                    : 'bg-white text-gray-600 border-gray-300 hover:border-navy-900'
                }`}>
                {cc ? `${countryFlag(cc)} ${cc}` : 'All'}
              </a>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 font-medium">Tier:</span>
          <div className="flex gap-1 flex-wrap">
            {TIERS.map(t => (
              <a key={t} href={filterUrl({ tier: t })}
                className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                  tier === t
                    ? 'bg-navy-900 text-white border-navy-900'
                    : 'bg-white text-gray-600 border-gray-300 hover:border-navy-900'
                }`}>
                {t ? t.charAt(0).toUpperCase() + t.slice(1) : 'All'}
              </a>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 font-medium">Status:</span>
          <div className="flex gap-1">
            {STATUSES.map(({ value, label }) => (
              <a key={value} href={filterUrl({ status: value })}
                className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                  status === value
                    ? 'bg-navy-900 text-white border-navy-900'
                    : 'bg-white text-gray-600 border-gray-300 hover:border-navy-900'
                }`}>
                {label}
              </a>
            ))}
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border shadow-sm overflow-hidden">
        {trends.length === 0 ? (
          <div className="py-16 text-center text-gray-400 text-sm">
            No trends detected yet. Run the Trend Detection agent to populate data.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50">
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Country</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Category</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Tier</th>
                <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase">Growth</th>
                <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase">Confidence</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Signals</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Status</th>
                <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase">Detected</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {trends.map(t => (
                <tr key={t.id} className="hover:bg-gray-50">
                  <td className="px-6 py-3 font-medium">
                    {countryFlag(t.countryCode)} {t.countryCode}
                  </td>
                  <td className="px-6 py-3 text-gray-700">{categoryLabel(t.category)}</td>
                  <td className="px-6 py-3"><TierBadge tier={t.opportunityTier} /></td>
                  <td className="px-6 py-3 text-right font-mono font-medium">
                    <span className={t.growthRate >= 0 ? 'text-green-700' : 'text-red-600'}>
                      {t.growthRate >= 0 ? '+' : ''}{(t.growthRate * 100).toFixed(1)}%
                    </span>
                  </td>
                  <td className="px-6 py-3 text-right">
                    <ConfidenceBar value={t.confidence} />
                  </td>
                  <td className="px-6 py-3">
                    <div className="flex gap-1 flex-wrap">
                      {t.isAccelerating && (
                        <Badge variant="green">↑ Accel</Badge>
                      )}
                      {(t.detectionMethods ?? []).slice(0, 2).map(m => (
                        <Badge key={m} variant="gray">{m.replace(/_/g, ' ')}</Badge>
                      ))}
                    </div>
                  </td>
                  <td className="px-6 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                      t.status === 'published' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'
                    }`}>
                      {t.status}
                    </span>
                  </td>
                  <td className="px-6 py-3 text-right text-gray-400 text-xs">
                    {relativeTime(t.createdAt)}
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

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const colour = pct >= 90 ? 'bg-green-500' : pct >= 75 ? 'bg-blue-500' : 'bg-yellow-400';
  return (
    <div className="flex items-center justify-end gap-2">
      <div className="w-16 h-1.5 bg-gray-200 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${colour}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-gray-600 w-8 text-right">{pct}%</span>
    </div>
  );
}
