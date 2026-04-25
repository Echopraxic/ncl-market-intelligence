import { getInsights } from '@/lib/api';
import { StatCard } from '@/components/StatCard';
import { TriggerButton } from '@/components/TriggerButton';
import { relativeTime } from '@/lib/utils';
import Link from 'next/link';

type SearchParams = Promise<{
  type?: string;
  status?: string;
}>;

const INSIGHT_TYPES = [
  { value: '',                   label: 'All types' },
  { value: 'opportunity_alert',  label: 'Alerts' },
  { value: 'market_brief',       label: 'Market Briefs' },
  { value: 'trade_show_playbook', label: 'Trade Show Playbooks' },
  { value: 'weekly_report',      label: 'Weekly Reports' },
];

const STATUSES = [
  { value: '',          label: 'All' },
  { value: 'draft',     label: 'Draft' },
  { value: 'published', label: 'Published' },
  { value: 'sent',      label: 'Sent' },
];

const TYPE_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  opportunity_alert:   { bg: 'bg-green-100',  text: 'text-green-700',  label: 'Alert' },
  market_brief:        { bg: 'bg-blue-100',   text: 'text-blue-700',   label: 'Brief' },
  trade_show_playbook: { bg: 'bg-amber-100',  text: 'text-amber-700',  label: 'Playbook' },
  weekly_report:       { bg: 'bg-purple-100', text: 'text-purple-700', label: 'Weekly' },
};

const STATUS_STYLES: Record<string, string> = {
  draft:     'bg-gray-100 text-gray-600',
  published: 'bg-emerald-100 text-emerald-700',
  sent:      'bg-navy-100 text-navy-700',
};

function TypeBadge({ type }: { type: string }) {
  const s = TYPE_STYLES[type] ?? { bg: 'bg-gray-100', text: 'text-gray-600', label: type };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${s.bg} ${s.text}`}>
      {s.label}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_STYLES[status] ?? 'bg-gray-100 text-gray-600'}`}>
      {status}
    </span>
  );
}

export default async function InsightsFeedPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const type   = params.type   ?? '';
  const status = params.status ?? '';

  const data = await getInsights({
    ...(type   ? { type }   : {}),
    ...(status ? { status } : {}),
    limit: 100,
  }).catch(() => ({ insights: [], count: 0, limit: 100 }));

  const insights = data.insights;

  const alertCount    = insights.filter(i => i.type === 'opportunity_alert').length;
  const briefCount    = insights.filter(i => i.type === 'market_brief').length;
  const playbookCount = insights.filter(i => i.type === 'trade_show_playbook').length;
  const weeklyCount   = insights.filter(i => i.type === 'weekly_report').length;

  function filterUrl(updates: Record<string, string>) {
    const merged = { type, status, ...updates };
    const q = new URLSearchParams(
      Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== '')),
    ).toString();
    return `/insights-feed${q ? `?${q}` : ''}`;
  }

  return (
    <div className="p-8 max-w-5xl">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-navy-900">Insights Feed</h1>
          <p className="text-gray-500 mt-1 text-sm">
            AI-generated intelligence from scored opportunities and signals · Phase 3
          </p>
        </div>
        <TriggerButton agentType="insights" label="Generate Insights" />
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard label="Total insights" value={insights.length} sub="matching filters" />
        <StatCard label="Opportunity alerts" value={alertCount} sub="corridor + brand alerts" />
        <StatCard label="Market briefs" value={briefCount} sub="top corridor analyses" />
        <StatCard label="Playbooks + Reports" value={playbookCount + weeklyCount} sub="trade show + weekly" />
      </div>

      {/* Filters */}
      <div className="bg-white rounded-lg border shadow-sm p-4 mb-6 flex flex-wrap items-center gap-6">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 font-medium">Type:</span>
          <div className="flex gap-1 flex-wrap">
            {INSIGHT_TYPES.map(({ value, label }) => (
              <a key={value} href={filterUrl({ type: value })}
                className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                  type === value
                    ? 'bg-navy-900 text-white border-navy-900'
                    : 'bg-white text-gray-600 border-gray-300 hover:border-navy-900'
                }`}>
                {label}
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

      {/* Insight cards */}
      {insights.length === 0 ? (
        <div className="bg-white rounded-lg border shadow-sm py-16 text-center text-gray-400 text-sm">
          No insights yet. Run the Insight Generation agent after scoring corridors and brands.
        </div>
      ) : (
        <div className="space-y-4">
          {insights.map(insight => {
            const preview = insight.body.length > 420
              ? insight.body.slice(0, 420).trimEnd() + '…'
              : insight.body;

            // Separate narrative from evidence block
            const evidenceSplit = preview.indexOf('\n\n---\n');
            const narrativePart = evidenceSplit > 0 ? preview.slice(0, evidenceSplit) : preview;
            const hasEvidence   = insight.body.includes('\n\n---\n');

            return (
              <div
                key={insight.id}
                className={`bg-white rounded-lg border shadow-sm p-5 ${
                  insight.type === 'opportunity_alert' && insight.status === 'draft'
                    ? 'border-l-4 border-l-green-400'
                    : insight.type === 'weekly_report'
                    ? 'border-l-4 border-l-purple-400'
                    : ''
                }`}
              >
                {/* Card header */}
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-center gap-2 flex-wrap">
                    <TypeBadge type={insight.type} />
                    <StatusBadge status={insight.status} />
                  </div>
                  <span className="text-xs text-gray-400 whitespace-nowrap">
                    {relativeTime(insight.createdAt)}
                  </span>
                </div>

                {/* Title */}
                <h3 className="font-semibold text-gray-900 mt-2 text-sm leading-snug">
                  {insight.title}
                </h3>

                {/* Body preview */}
                <p className="text-gray-600 text-xs mt-2 leading-relaxed whitespace-pre-line">
                  {narrativePart}
                </p>

                {/* Evidence trail indicator */}
                {hasEvidence && (
                  <p className="text-xs text-gray-400 mt-2 italic">
                    + evidence summary attached (scoring factors, signals)
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="text-xs text-gray-400 mt-6">
        Insights are generated by the InsightGenerationAgent after each scoring run.
        Alerts fire for corridor and brand composite scores ≥ 80.
        Market briefs cover the top 10 corridors. Trade show playbooks cover upcoming shows.
        Weekly reports are generated once per ISO week.
      </p>
    </div>
  );
}
