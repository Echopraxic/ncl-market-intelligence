import { getRetailerInsights } from '@/lib/api';
import { PatternBadge } from '@/components/Badge';
import { StatCard } from '@/components/StatCard';
import { TriggerButton } from '@/components/TriggerButton';
import { countryFlag, relativeTime } from '@/lib/utils';

type SearchParams = Promise<{
  countryCode?: string;
  category?: string;
  patternType?: string;
}>;

const COUNTRIES = ['', 'DE', 'FR', 'NL', 'GB', 'ES', 'IT'];
const PATTERNS  = [
  { value: '',               label: 'All patterns'   },
  { value: 'expansion',      label: 'Expansion'      },
  { value: 'rotation',       label: 'Rotation'       },
  { value: 'us_brand_entry', label: 'US Brand Entry' },
];

const PATTERN_DESCRIPTIONS: Record<string, string> = {
  expansion:      'Retailers actively expanding a category — new SKUs, shelf space, dedicated sections',
  rotation:       'Seasonal or cyclical category swaps — indicates buyer-driven demand cycles',
  us_brand_entry: 'Retailers explicitly stocking US-origin brands — direct acquisition signal for NCL',
};

function categoryLabel(c: string) {
  return c.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) || 'All';
}

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const colour = pct >= 80 ? 'bg-green-500' : pct >= 60 ? 'bg-blue-400' : 'bg-yellow-400';
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 bg-gray-200 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${colour}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs tabular-nums text-gray-600">{pct}%</span>
    </div>
  );
}

export default async function RetailerInsightsPage({ searchParams }: { searchParams: SearchParams }) {
  const params    = await searchParams;
  const country   = params.countryCode  ?? '';
  const category  = params.category    ?? '';
  const pattern   = params.patternType  ?? '';

  const data = await getRetailerInsights({
    ...(country  ? { countryCode: country } : {}),
    ...(category ? { category }            : {}),
    ...(pattern  ? { patternType: pattern } : {}),
    limit: 100,
  }).catch(() => ({ insights: [], limit: 100 }));

  const insights = data.insights;

  const byPattern = insights.reduce<Record<string, number>>((acc, i) => {
    acc[i.patternType] = (acc[i.patternType] ?? 0) + 1;
    return acc;
  }, {});

  const usEntryCount = byPattern.us_brand_entry ?? 0;
  const avgConfidence = insights.length
    ? (insights.reduce((s, i) => s + i.confidence, 0) / insights.length * 100).toFixed(0)
    : '—';

  function filterUrl(updates: Record<string, string>) {
    const merged = { countryCode: country, category, patternType: pattern, ...updates };
    const q = new URLSearchParams(
      Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== '')),
    ).toString();
    return `/retailer-insights${q ? `?${q}` : ''}`;
  }

  return (
    <div className="p-8 max-w-6xl">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-navy-900">Retailer Insights</h1>
          <p className="text-gray-500 mt-1 text-sm">
            EU retailer behaviour patterns — expansion, rotation, and US brand entry signals
          </p>
        </div>
        <TriggerButton agentType="retailer" label="Run Retailer Agent" />
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard label="Patterns detected" value={insights.length} sub="matching filters" />
        <StatCard label="US brand entries" value={usEntryCount} sub="direct acquisition signals" />
        <StatCard label="Expansions" value={byPattern.expansion ?? 0} sub="category shelf growth" />
        <StatCard label="Avg confidence" value={insights.length ? `${avgConfidence}%` : '—'} />
      </div>

      {/* Pattern guide — shown when no pattern filter active */}
      {pattern === '' && (
        <div className="bg-white rounded-lg border shadow-sm p-4 mb-6 space-y-2">
          <p className="text-xs font-medium text-gray-500 uppercase mb-2">Pattern Guide</p>
          {Object.entries(PATTERN_DESCRIPTIONS).map(([k, desc]) => (
            <a key={k} href={filterUrl({ patternType: k })}
              className="flex items-start gap-3 hover:bg-gray-50 p-1.5 rounded transition-colors">
              <PatternBadge pattern={k} />
              <span className="text-xs text-gray-500 pt-0.5">{desc}</span>
            </a>
          ))}
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
          <span className="text-xs text-gray-500 font-medium">Pattern:</span>
          <div className="flex gap-1">
            {PATTERNS.map(({ value, label }) => (
              <a key={value} href={filterUrl({ patternType: value })}
                className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                  pattern === value
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
        {insights.length === 0 ? (
          <div className="py-16 text-center text-gray-400 text-sm">
            No retailer insights yet. Run the Retailer Behaviour agent to populate data.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50">
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Country</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Category</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Pattern</th>
                <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase">Retailers</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Confidence</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Retailers named</th>
                <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase">Detected</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {insights.map(ins => (
                <tr key={ins.id} className={`hover:bg-gray-50 ${ins.patternType === 'us_brand_entry' ? 'bg-amber-50/40' : ''}`}>
                  <td className="px-6 py-3 font-medium">
                    {countryFlag(ins.countryCode)} {ins.countryCode}
                  </td>
                  <td className="px-6 py-3 text-gray-700">{categoryLabel(ins.category)}</td>
                  <td className="px-6 py-3"><PatternBadge pattern={ins.patternType} /></td>
                  <td className="px-6 py-3 text-right font-mono text-gray-700">{ins.retailerCount}</td>
                  <td className="px-6 py-3"><ConfidenceBar value={ins.confidence} /></td>
                  <td className="px-6 py-3 text-gray-500 text-xs max-w-xs truncate">
                    {ins.ruleDetails?.retailerNames?.slice(0, 4).join(', ') ?? '—'}
                  </td>
                  <td className="px-6 py-3 text-right text-gray-400 text-xs">
                    {relativeTime(ins.detectedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* AI synthesis panel — shown for insights that have it */}
      {insights.some(i => i.aiSynthesis) && (
        <div className="mt-6 space-y-3">
          <h2 className="text-sm font-semibold text-gray-700">AI Synthesis</h2>
          {insights.filter(i => i.aiSynthesis).map(ins => (
            <div key={ins.id} className="bg-white rounded-lg border shadow-sm p-4">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs font-medium text-gray-700">
                  {countryFlag(ins.countryCode)} {ins.countryCode} · {categoryLabel(ins.category)}
                </span>
                <PatternBadge pattern={ins.patternType} />
              </div>
              <p className="text-sm text-gray-600 leading-relaxed">{ins.aiSynthesis}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
