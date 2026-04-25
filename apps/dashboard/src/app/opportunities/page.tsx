import { getOpportunityScores, getBrandScores } from '@/lib/api';
import { StatCard } from '@/components/StatCard';
import { TriggerButton } from '@/components/TriggerButton';
import { countryFlag, relativeTime } from '@/lib/utils';
import Link from 'next/link';

type SearchParams = Promise<{
  view?: string;
  countryCode?: string;
  category?: string;
  minComposite?: string;
}>;

const COUNTRIES  = ['', 'DE', 'FR', 'NL', 'GB', 'ES', 'IT'];
const CATEGORIES = ['', 'food_beverage', 'supplements', 'cosmetics_personal_care', 'home_goods', 'toys_games'];
const THRESHOLDS = [
  { value: '',   label: 'All' },
  { value: '60', label: '60+' },
  { value: '70', label: '70+' },
  { value: '80', label: '80+' },
];

const CATEGORY_LABELS: Record<string, string> = {
  food_beverage:           'Food & Beverage',
  supplements:             'Health & Wellness',
  cosmetics_personal_care: 'Beauty & Personal Care',
  home_goods:              'Home Goods',
  toys_games:              'Toys & Games',
};

function catLabel(c: string) {
  return CATEGORY_LABELS[c] ?? c.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
}

function scoreColour(s: number) {
  if (s >= 80) return 'text-green-700 font-bold';
  if (s >= 70) return 'text-blue-700 font-semibold';
  if (s >= 60) return 'text-amber-600 font-medium';
  return 'text-gray-500';
}

function ScoreBar({ value, colour }: { value: number; colour: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 bg-gray-200 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${colour}`} style={{ width: `${Math.min(100, value)}%` }} />
      </div>
      <span className="text-xs text-gray-500 tabular-nums w-7">{value.toFixed(0)}</span>
    </div>
  );
}

function TabLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={`px-4 py-2 text-sm font-medium rounded-t-md transition-colors ${
        active
          ? 'bg-white text-navy-900 border border-b-white border-gray-200'
          : 'text-gray-500 hover:text-navy-900'
      }`}
    >
      {children}
    </Link>
  );
}

export default async function OpportunitiesPage({ searchParams }: { searchParams: SearchParams }) {
  const params      = await searchParams;
  const view        = params.view        ?? 'corridors';
  const country     = params.countryCode ?? '';
  const category    = params.category    ?? '';
  const minComposite = params.minComposite ?? '';

  const isBrands = view === 'brands';

  const filterArgs = {
    ...(country      ? { countryCode: country }                : {}),
    ...(category     ? { category }                            : {}),
    ...(minComposite ? { minComposite: parseFloat(minComposite) } : {}),
    limit: 100,
  };

  const [corridorData, brandData] = await Promise.all([
    getOpportunityScores(filterArgs).catch(() => ({ scores: [], count: 0, limit: 100 })),
    getBrandScores(filterArgs).catch(() => ({ scores: [], count: 0, limit: 100 })),
  ]);

  const corridors = corridorData.scores;
  const brands    = brandData.scores;

  const allAbove80 = brands.filter(b => b.compositeScore >= 80).length;
  const allAbove70 = brands.filter(b => b.compositeScore >= 70).length;
  const topCorridor = corridors[0];

  function filterUrl(updates: Record<string, string>) {
    const merged = { view, countryCode: country, category, minComposite, ...updates };
    const q = new URLSearchParams(
      Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== '')),
    ).toString();
    return `/opportunities${q ? `?${q}` : ''}`;
  }

  return (
    <div className="p-8 max-w-6xl">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-navy-900">Opportunity Leaderboard</h1>
          <p className="text-gray-500 mt-1 text-sm">
            Composite scores ranked by EU expansion potential · Phase 3
          </p>
        </div>
        <div className="flex gap-2">
          <TriggerButton agentType="composite-scoring" label="Score Corridors" />
          <TriggerButton agentType="brand-fit" label="Score Brands" />
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard label="Corridors scored" value={corridors.length} sub="category × country pairs" />
        <StatCard label="Brands above 80" value={allAbove80} sub="auto-queue outreach threshold" />
        <StatCard label="Brands 70–80" value={allAbove70 - allAbove80} sub="human review queue" />
        <StatCard
          label="Top corridor"
          value={topCorridor ? `${countryFlag(topCorridor.countryCode)} ${topCorridor.countryCode}` : '—'}
          sub={topCorridor ? catLabel(topCorridor.category) : 'no data yet'}
        />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-0 border-b border-gray-200">
        <TabLink href={filterUrl({ view: 'corridors' })} active={!isBrands}>
          Corridors ({corridors.length})
        </TabLink>
        <TabLink href={filterUrl({ view: 'brands' })} active={isBrands}>
          Brands ({brands.length})
        </TabLink>
      </div>

      {/* Filters */}
      <div className="bg-white border border-t-0 rounded-b-none border-gray-200 p-4 mb-6 flex flex-wrap items-center gap-6">
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
          <span className="text-xs text-gray-500 font-medium">Category:</span>
          <div className="flex gap-1 flex-wrap">
            {CATEGORIES.map(cat => (
              <a key={cat} href={filterUrl({ category: cat })}
                className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                  category === cat
                    ? 'bg-navy-900 text-white border-navy-900'
                    : 'bg-white text-gray-600 border-gray-300 hover:border-navy-900'
                }`}>
                {cat ? catLabel(cat) : 'All'}
              </a>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 font-medium">Min score:</span>
          <div className="flex gap-1">
            {THRESHOLDS.map(({ value, label }) => (
              <a key={value} href={filterUrl({ minComposite: value })}
                className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                  minComposite === value
                    ? 'bg-navy-900 text-white border-navy-900'
                    : 'bg-white text-gray-600 border-gray-300 hover:border-navy-900'
                }`}>
                {label}
              </a>
            ))}
          </div>
        </div>
      </div>

      {/* ── Corridors table ── */}
      {!isBrands && (
        <div className="bg-white rounded-lg border shadow-sm overflow-hidden">
          {corridors.length === 0 ? (
            <div className="py-16 text-center text-gray-400 text-sm">
              No corridor scores yet. Run Composite Scoring to populate data.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-50">
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase w-8">#</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Country</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Category</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Composite</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Category</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Brand Proxy</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">NI Signal</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Scored</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {corridors.map((row, i) => (
                  <tr key={row.id} className={`hover:bg-gray-50 ${row.compositeScore >= 80 ? 'bg-green-50/30' : ''}`}>
                    <td className="px-4 py-3 text-gray-400 text-xs">{i + 1}</td>
                    <td className="px-4 py-3 font-medium">{countryFlag(row.countryCode)} {row.countryCode}</td>
                    <td className="px-4 py-3 text-gray-700">{catLabel(row.category)}</td>
                    <td className="px-4 py-3 text-right">
                      <span className={`text-base tabular-nums ${scoreColour(row.compositeScore)}`}>
                        {row.compositeScore.toFixed(1)}
                      </span>
                    </td>
                    <td className="px-4 py-3"><ScoreBar value={row.categoryOpportunityScore} colour="bg-blue-400" /></td>
                    <td className="px-4 py-3"><ScoreBar value={row.brandFitScore} colour="bg-amber-400" /></td>
                    <td className="px-4 py-3"><ScoreBar value={row.niSuitabilityPreScore} colour="bg-purple-400" /></td>
                    <td className="px-4 py-3 text-right text-gray-400 text-xs">{relativeTime(row.generatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ── Brands table ── */}
      {isBrands && (
        <div className="bg-white rounded-lg border shadow-sm overflow-hidden">
          {brands.length === 0 ? (
            <div className="py-16 text-center text-gray-400 text-sm">
              No brand scores yet. Run Composite Scoring then Brand Fit Scoring.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-50">
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase w-8">#</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Brand</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Category</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Country</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Composite</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Brand Fit</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">NI Suitability</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Signals</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Scored</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {brands.map((row, i) => (
                  <tr key={row.id} className={`hover:bg-gray-50 ${row.compositeScore >= 80 ? 'bg-green-50/30' : row.compositeScore >= 70 ? 'bg-blue-50/20' : ''}`}>
                    <td className="px-4 py-3 text-gray-400 text-xs">{i + 1}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900">{row.brandName}</div>
                      <div className="flex gap-2 mt-0.5">
                        {!row.euPresence && <span className="text-xs text-green-600">US-only</span>}
                        {row.shopifyStoreUrl && <span className="text-xs text-blue-600">Shopify</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-700 text-xs">{catLabel(row.category)}</td>
                    <td className="px-4 py-3 font-medium">{countryFlag(row.countryCode)} {row.countryCode}</td>
                    <td className="px-4 py-3 text-right">
                      <span className={`text-base tabular-nums ${scoreColour(row.compositeScore)}`}>
                        {row.compositeScore.toFixed(1)}
                      </span>
                    </td>
                    <td className="px-4 py-3"><ScoreBar value={row.brandFitScore} colour="bg-amber-400" /></td>
                    <td className="px-4 py-3"><ScoreBar value={row.niSuitabilityPreScore} colour="bg-purple-400" /></td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1">
                        {row.compositeScore >= 80 && (
                          <span className="px-1.5 py-0.5 rounded text-xs bg-green-100 text-green-700">Outreach</span>
                        )}
                        {row.compositeScore >= 70 && row.compositeScore < 80 && (
                          <span className="px-1.5 py-0.5 rounded text-xs bg-blue-100 text-blue-700">Review</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right text-gray-400 text-xs">{relativeTime(row.generatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <p className="text-xs text-gray-400 mt-3">
        Composite = 40% Category Opportunity + 35% Brand Fit + 25% NI Suitability.
        Corridors show category-level scores (brandId = null). Brands show per-brand×corridor pairs.
        Green rows ≥ 80 (auto-queue outreach) · Blue rows ≥ 70 (human review).
      </p>
    </div>
  );
}
