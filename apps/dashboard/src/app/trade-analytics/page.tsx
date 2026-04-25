import { getTradeAnalytics } from '@/lib/api';
import { Badge } from '@/components/Badge';
import { StatCard } from '@/components/StatCard';
import { TriggerButton } from '@/components/TriggerButton';
import { countryFlag } from '@/lib/utils';

type SearchParams = Promise<{
  country?: string;
  category?: string;
  isAccelerating?: string;
}>;

const COUNTRIES  = ['', 'DE', 'FR', 'NL', 'GB', 'ES', 'IT'];
const CATEGORIES = ['', 'food_beverage', 'supplements', 'cosmetics_personal_care', 'home_goods', 'toys_games'];

function categoryLabel(c: string) {
  return c.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) || 'All';
}

function pct(n: number | null, decimals = 1) {
  if (n === null || n === undefined) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}%`;
}

function ShareBar({ us, cn, gb, row }: { us: number | null; cn: number | null; gb: number | null; row: number | null }) {
  const total = (us ?? 0) + (cn ?? 0) + (gb ?? 0) + (row ?? 0);
  if (total === 0) return <span className="text-xs text-gray-400">—</span>;

  const segments = [
    { label: 'US', pct: ((us ?? 0) / total) * 100, colour: 'bg-blue-500' },
    { label: 'CN', pct: ((cn ?? 0) / total) * 100, colour: 'bg-red-400' },
    { label: 'GB', pct: ((gb ?? 0) / total) * 100, colour: 'bg-amber-400' },
    { label: 'RoW', pct: ((row ?? 0) / total) * 100, colour: 'bg-gray-300' },
  ];

  return (
    <div className="flex items-center gap-1.5">
      <div className="flex h-2 w-28 rounded-full overflow-hidden">
        {segments.map(s => (
          <div key={s.label} className={s.colour} style={{ width: `${s.pct}%` }} title={`${s.label}: ${s.pct.toFixed(0)}%`} />
        ))}
      </div>
      <span className="text-xs text-blue-700 tabular-nums">{(us ?? 0).toFixed(0)}%</span>
    </div>
  );
}

function AccelerationCell({ score, isAccelerating }: { score: number | null; isAccelerating: boolean }) {
  if (score === null) return <span className="text-xs text-gray-400">—</span>;
  const colour = isAccelerating
    ? score > 0.5 ? 'text-green-700 font-bold' : 'text-green-600'
    : 'text-gray-500';
  return (
    <span className={`text-sm tabular-nums ${colour}`}>
      {isAccelerating ? '↑ ' : ''}{score.toFixed(2)}
    </span>
  );
}

export default async function TradeAnalyticsPage({ searchParams }: { searchParams: SearchParams }) {
  const params    = await searchParams;
  const country   = params.country        ?? '';
  const category  = params.category       ?? '';
  const accelOnly = params.isAccelerating === 'true';

  const data = await getTradeAnalytics({
    ...(country   ? { country }               : {}),
    ...(category  ? { category }              : {}),
    ...(accelOnly ? { isAccelerating: true }  : {}),
    limit: 150,
  }).catch(() => ({ analytics: [], count: 0, limit: 150 }));

  const rows = data.analytics;

  const acceleratingCount  = rows.filter(r => r.isAccelerating).length;
  const breakpointCount    = rows.filter(r => r.breakpointDetected).length;
  const saturationFlagCount = rows.filter(r => r.oversupplySaturationFlag).length;
  const gainers = rows.filter(r => r.shareTrend === 'gaining').length;

  function filterUrl(updates: Record<string, string>) {
    const merged = {
      country,
      category,
      isAccelerating: accelOnly ? 'true' : '',
      ...updates,
    };
    const q = new URLSearchParams(
      Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== '')),
    ).toString();
    return `/trade-analytics${q ? `?${q}` : ''}`;
  }

  return (
    <div className="p-8 max-w-7xl">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-navy-900">Trade Analytics</h1>
          <p className="text-gray-500 mt-1 text-sm">
            Multi-layer US→EU trade flow analysis — acceleration, market share, breakpoints, saturation
          </p>
        </div>
        <TriggerButton agentType="trade-analytics" label="Run Analytics" />
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard label="Corridors" value={rows.length} sub="category × country pairs" />
        <StatCard label="Accelerating" value={acceleratingCount} sub="short-term > long-term momentum" />
        <StatCard label="Breakpoints" value={breakpointCount} sub="structural slope shifts detected" />
        <StatCard label="Saturation flags" value={saturationFlagCount} sub="imports outpacing consumption" />
      </div>

      {/* Filters */}
      <div className="bg-white rounded-lg border shadow-sm p-4 mb-6 flex flex-wrap items-center gap-6">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 font-medium">Country:</span>
          <div className="flex gap-1 flex-wrap">
            {COUNTRIES.map(cc => (
              <a key={cc} href={filterUrl({ country: cc })}
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
          <span className="text-xs text-gray-500 font-medium">Category:</span>
          <div className="flex gap-1 flex-wrap">
            {CATEGORIES.map(c => (
              <a key={c} href={filterUrl({ category: c })}
                className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                  category === c
                    ? 'bg-navy-900 text-white border-navy-900'
                    : 'bg-white text-gray-600 border-gray-300 hover:border-navy-900'
                }`}>
                {c ? categoryLabel(c) : 'All'}
              </a>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 font-medium">Show:</span>
          <a href={filterUrl({ isAccelerating: accelOnly ? '' : 'true' })}
            className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
              accelOnly
                ? 'bg-green-600 text-white border-green-600'
                : 'bg-white text-gray-600 border-gray-300 hover:border-navy-900'
            }`}>
            Accelerating only
          </a>
        </div>
      </div>

      {/* Main table */}
      <div className="bg-white rounded-lg border shadow-sm overflow-x-auto">
        {rows.length === 0 ? (
          <div className="py-16 text-center text-gray-400 text-sm">
            No trade analytics yet. Run the Trade Flow Analytics agent to populate data.
          </div>
        ) : (
          <table className="w-full text-sm whitespace-nowrap">
            <thead>
              <tr className="border-b bg-gray-50">
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Country</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Category</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">HS</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">YoY</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">3yr CAGR</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Acceleration</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">US share (vs CN/GB)</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Share trend</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Signals</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map(r => (
                <tr key={r.id} className={`hover:bg-gray-50 ${r.isAccelerating ? 'bg-green-50/20' : ''} ${r.oversupplySaturationFlag ? 'bg-red-50/20' : ''}`}>
                  <td className="px-4 py-3 font-medium">
                    {countryFlag(r.reporterCountry)} {r.reporterCountry}
                  </td>
                  <td className="px-4 py-3 text-gray-700">{categoryLabel(r.nclCategory)}</td>
                  <td className="px-4 py-3 text-gray-400 font-mono text-xs">{r.hsChapter}</td>
                  <td className="px-4 py-3 text-right">
                    <span className={r.yoyGrowthPct !== null && r.yoyGrowthPct >= 0 ? 'text-green-700' : 'text-red-600'}>
                      {pct(r.yoyGrowthPct)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-gray-600">{pct(r.cagr3yr)}</td>
                  <td className="px-4 py-3">
                    <AccelerationCell score={r.accelerationScore} isAccelerating={r.isAccelerating} />
                  </td>
                  <td className="px-4 py-3">
                    <ShareBar
                      us={r.usMarketSharePct}
                      cn={null}
                      gb={null}
                      row={r.usMarketSharePct !== null ? 100 - r.usMarketSharePct : null}
                    />
                  </td>
                  <td className="px-4 py-3">
                    {r.shareTrend === 'gaining' && <Badge variant="green">Gaining</Badge>}
                    {r.shareTrend === 'losing'  && <Badge variant="red">Losing</Badge>}
                    {r.shareTrend === 'stable'  && <Badge variant="gray">Stable</Badge>}
                    {!r.shareTrend              && <span className="text-gray-400 text-xs">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1">
                      {r.breakpointDetected      && <Badge variant="blue">{r.breakpointType ?? 'Breakpoint'}</Badge>}
                      {r.oversupplySaturationFlag && <Badge variant="red">Saturation</Badge>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="text-xs text-gray-400 mt-3">
        Acceleration = short-term momentum ÷ long-term baseline. Breakpoint = OLS slope shift {'>'} 50% between first and second half of observation window.
        Rows highlighted green are accelerating; red rows have an oversupply saturation flag.
      </p>
    </div>
  );
}
