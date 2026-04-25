import { getLeadPipeline } from '@/lib/api';
import type { PipelineStage } from '@/lib/api';
import { StatCard } from '@/components/StatCard';

const STAGE_ORDER: PipelineStage[] = ['prospecting', 'engaged', 'qualified', 'proposal', 'negotiation', 'closed_won', 'closed_lost'];

const STAGE_LABELS: Record<PipelineStage, string> = {
  prospecting:  'Prospecting',
  engaged:      'Engaged',
  qualified:    'Qualified',
  proposal:     'Proposal',
  negotiation:  'Negotiation',
  closed_won:   'Closed Won',
  closed_lost:  'Closed Lost',
};

const STAGE_COLOURS: Record<PipelineStage, string> = {
  prospecting:  'bg-gray-100 text-gray-700 border-gray-200',
  engaged:      'bg-blue-100 text-blue-800 border-blue-200',
  qualified:    'bg-indigo-100 text-indigo-800 border-indigo-200',
  proposal:     'bg-purple-100 text-purple-800 border-purple-200',
  negotiation:  'bg-amber-100 text-amber-800 border-amber-200',
  closed_won:   'bg-green-100 text-green-800 border-green-200',
  closed_lost:  'bg-red-100 text-red-700 border-red-200',
};

function formatValue(v: number) {
  if (v >= 1_000_000) return `£${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `£${(v / 1_000).toFixed(0)}K`;
  return `£${v.toFixed(0)}`;
}

export default async function LeadPipelinePage() {
  const data = await getLeadPipeline().catch(() => ({
    stages: [],
    totalLeads: 0,
    totalEstimatedValue: 0,
  }));

  const stageMap = new Map(data.stages.map(s => [s.stage, s]));
  const wonLeads = stageMap.get('closed_won')?.count ?? 0;
  const totalActive = data.stages
    .filter(s => !['closed_won', 'closed_lost'].includes(s.stage))
    .reduce((acc, s) => acc + s.count, 0);

  const winRate = data.totalLeads > 0
    ? ((wonLeads / data.totalLeads) * 100).toFixed(0)
    : '0';

  return (
    <div className="p-8 max-w-6xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-navy-900">Lead Pipeline</h1>
        <p className="text-gray-500 mt-1 text-sm">Funnel view from prospecting through to closed deals</p>
      </div>

      <div className="grid grid-cols-4 gap-4 mb-8">
        <StatCard label="Total leads" value={data.totalLeads} sub="all stages" />
        <StatCard label="Active pipeline" value={totalActive} sub="prospecting → negotiation" />
        <StatCard label="Win rate" value={`${winRate}%`} sub="closed_won / total" />
        <StatCard label="Est. pipeline value" value={formatValue(data.totalEstimatedValue)} sub="sum of estimated values" />
      </div>

      {/* Stage columns */}
      <div className="grid grid-cols-7 gap-3">
        {STAGE_ORDER.map(stage => {
          const s = stageMap.get(stage);
          const count = s?.count ?? 0;
          const value = s?.totalValue ?? 0;
          return (
            <div key={stage} className={`rounded-lg border p-4 ${STAGE_COLOURS[stage]}`}>
              <div className="text-xs font-semibold uppercase tracking-wide mb-2">
                {STAGE_LABELS[stage]}
              </div>
              <div className="text-3xl font-bold tabular-nums">{count}</div>
              <div className="text-xs mt-1 opacity-70">leads</div>
              {value > 0 && (
                <div className="text-xs font-semibold mt-2">{formatValue(value)}</div>
              )}
            </div>
          );
        })}
      </div>

      {data.totalLeads === 0 && (
        <div className="mt-8 py-12 text-center text-gray-400 text-sm border rounded-lg bg-white">
          No pipeline data yet. Run Lead Discovery and Lead Scoring to populate the pipeline.
        </div>
      )}

      <p className="text-xs text-gray-400 mt-6">
        Pipeline stage is updated automatically when leads reply (engaged/qualified) or are manually advanced.
        Estimated values are set during the negotiation stage.
      </p>
    </div>
  );
}
