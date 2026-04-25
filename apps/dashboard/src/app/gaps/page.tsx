import { getGapScores } from '@/lib/api';
import { TierBadge } from '@/components/Badge';
import { StatCard } from '@/components/StatCard';
import { TriggerButton } from '@/components/TriggerButton';
import { countryFlag, relativeTime } from '@/lib/utils';

type SearchParams = Promise<{
  countryCode?: string;
  category?: string;
  minGapScore?: string;
}>;

const COUNTRIES  = ['', 'DE', 'FR', 'NL', 'GB', 'ES', 'IT'];
const CATEGORIES = ['', 'food_beverage', 'supplements', 'cosmetics_personal_care', 'home_goods', 'toys_games'];
const THRESHOLDS = [
  { value: '',   label: 'All' },
  { value: '50', label: '50+' },
  { value: '70', label: '70+' },
  { value: '80', label: '80+' },
];

function categoryLabel(c: string) {
  return c.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) || 'All';
}

function scoreColour(score: number) {
  if (score >= 80) return 'text-green-700 font-bold';
  if (score >= 60) return 'text-blue-700 font-semibold';
  if (score >= 40) return 'text-amber-600';
  return 'text-gray-500';
}

function ScoreBar({ value, max = 100, colour }: { value: number; max?: number; colour: string }) {
  const pct = Math.round((value / max) * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="w-20 h-1.5 bg-gray-200 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${colour}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-gray-600 tabular-nums w-8">{value.toFixed(0)}</span>
    </div>
  );
}

export default async function GapsPage({ searchParams }: { searchParams: SearchParams }) {
  const params     = await searchParams;
  const country    = params.countryCode  ?? '';
  const category   = params.category    ?? '';
  const minScore   = params.minGapScore  ?? '';

  const data = await getGapScores({
    ...(country   ? { countryCode: country }              : {}),
    ...(category  ? { category }                         : {}),
    ...(minScore  ? { minGapScore: parseFloat(minScore) } : {}),
    limit: 100,
  }).catch(() => ({ gaps: [], limit: 100 }));

  const gaps = data.gaps;

  const topGap    = gaps[0];
  const above80   = gaps.filter(g => g.gapScore >= 80).length;
  const avgScore  = gaps.length
    ? (gaps.reduce((s, g) => s + g.gapScore, 0) / gaps.length).toFixed(0)
    : '—';

  function filterUrl(updates: Record<string, string>) {
    const merged = { countryCode: country, category, minGapScore: minScore, ...updates };
    const q = new URLSearchParams(
      Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== '')),
    ).toString();
    return `/gaps${q ? `?${q}` : ''}`;
  }

  return (
    <div className="p-8 max-w-6xl">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-navy-900">Gap Score Leaderboard</h1>
          <p className="text-gray-500 mt-1 text-sm">
            Demand–supply opportunity gaps ranked by composite score
          </p>
        </div>
        <TriggerButton agentType="gap" label="Run Gap Scoring" />
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard label="Corridors scored" value={gaps.length} sub="matching filters" />
        <StatCard label="Score ≥ 80" value={above80} sub="high-priority opportunities" />
        <StatCard label="Avg gap score" value={avgScore} sub="0–100 composite" />
        <StatCard
          label="Top opportunity"
          value={topGap ? `${countryFlag(topGap.countryCode)} ${topGap.countryCode}` : '—'}
          sub={topGap ? categoryLabel(topGap.category) : ''}
        />
      </div>

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
          <span className="text-xs text-gray-500 font-medium">Min score:</span>
          <div className="flex gap-1">
            {THRESHOLDS.map(({ value, label }) => (
              <a key={value} href={filterUrl({ minGapScore: value })}
                className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                  minScore === value
                    ? 'bg-navy-900 text-white border-navy-900'
                    : 'bg-white text-gray-600 border-gray-300 hover:border-navy-900'
                }`}>
                {label}
              </a>
            ))}
          </div>
        </div>
      </div>

      {/* Leaderboard table */}
      <div className="bg-white rounded-lg border shadow-sm overflow-hidden">
        {gaps.length === 0 ? (
          <div className="py-16 text-center text-gray-400 text-sm">
            No gap scores yet. Run the Gap Scoring agent to populate data.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50">
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase w-8">#</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Country</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Category</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Gap Score</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Demand</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Import Reliance</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Local Density</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Scored</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {gaps.map((g, i) => (
                <tr key={g.id} className={`hover:bg-gray-50 ${g.gapScore >= 80 ? 'bg-green-50/30' : ''}`}>
                  <td className="px-4 py-3 text-gray-400 text-xs">{i + 1}</td>
                  <td className="px-4 py-3 font-medium">
                    {countryFlag(g.countryCode)} {g.countryCode}
                  </td>
                  <td className="px-4 py-3 text-gray-700">{categoryLabel(g.category)}</td>
                  <td className="px-4 py-3 text-right">
                    <span className={`text-base tabular-nums ${scoreColour(g.gapScore)}`}>
                      {g.gapScore.toFixed(0)}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <ScoreBar value={g.demandPercentile * 100} colour="bg-blue-400" />
                  </td>
                  <td className="px-4 py-3">
                    <ScoreBar value={g.importPercentile * 100} colour="bg-amber-400" />
                  </td>
                  <td className="px-4 py-3">
                    {/* Inverted: low density = high opportunity */}
                    <ScoreBar value={(1 - g.densityPercentile) * 100} colour="bg-purple-400" />
                  </td>
                  <td className="px-4 py-3 text-right text-gray-400 text-xs">
                    {relativeTime(g.generatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Score formula note */}
      <p className="text-xs text-gray-400 mt-3">
        Score = 100 × (40% demand percentile + 35% import reliance percentile + 25% inverse brand density).
        Demand bar = demand signal percentile · Import bar = US import reliance percentile · Density bar = inverse local brand density (higher = less competition).
      </p>
    </div>
  );
}
