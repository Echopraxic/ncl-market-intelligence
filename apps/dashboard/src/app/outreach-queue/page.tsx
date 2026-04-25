import { getHumanReview, getCampaigns } from '@/lib/api';
import { ReviewStatusBadge } from '@/components/Badge';
import { StatCard } from '@/components/StatCard';
import { TriggerButton } from '@/components/TriggerButton';
import { relativeTime } from '@/lib/utils';
import { ReviewActions } from '../human-review/ReviewActions';

type SearchParams = Promise<{ status?: string }>;

const STATUS_OPTS = [
  { value: 'pending',  label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: '',         label: 'All' },
];

function priorityColour(p: number) {
  if (p >= 3) return 'text-red-600 font-semibold';
  if (p === 2) return 'text-amber-600 font-medium';
  return 'text-gray-400';
}

function pitchBadge(angle: string | null) {
  const colours: Record<string, string> = {
    first_mover:       'bg-purple-100 text-purple-800',
    unmet_demand:      'bg-blue-100 text-blue-800',
    cost_optimisation: 'bg-green-100 text-green-800',
    margin_expansion:  'bg-amber-100 text-amber-800',
  };
  if (!angle) return null;
  return (
    <span className={`inline-block text-xs px-2 py-0.5 rounded-full font-medium ${colours[angle] ?? 'bg-gray-100 text-gray-600'}`}>
      {angle.replace(/_/g, ' ')}
    </span>
  );
}

export default async function OutreachQueuePage({ searchParams }: { searchParams: SearchParams }) {
  const params       = await searchParams;
  const statusFilter = params.status ?? 'pending';

  const data = await getHumanReview({
    type: 'lead_outreach',
    ...(statusFilter ? { status: statusFilter } : {}),
    limit: 100,
  }).catch(() => ({ items: [], count: 0, limit: 100 }));

  const items = data.items;
  const pending  = items.filter(i => i.status === 'pending').length;
  const approved = items.filter(i => i.status === 'approved').length;
  const high     = items.filter(i => i.priority >= 3).length;

  function filterUrl(status: string) {
    const q = status ? `?status=${status}` : '';
    return `/outreach-queue${q}`;
  }

  return (
    <div className="p-8 max-w-6xl">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-navy-900">Outreach Queue</h1>
          <p className="text-gray-500 mt-1 text-sm">
            Lead outreach emails pending human approval before sending.
          </p>
        </div>
        <TriggerButton agentType="lead-outreach" label="Generate Outreach" />
      </div>

      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard label="Pending approval" value={pending} sub="need a decision" />
        <StatCard label="High priority" value={high} sub="score ≥ 80" />
        <StatCard label="Approved" value={approved} sub="sent or queued" />
        <StatCard label="Total" value={items.length} sub="in current view" />
      </div>

      <div className="bg-white rounded-lg border shadow-sm p-4 mb-6 flex items-center gap-2">
        <span className="text-xs text-gray-500 font-medium">Status:</span>
        <div className="flex gap-1">
          {STATUS_OPTS.map(({ value, label }) => (
            <a key={value} href={filterUrl(value)}
              className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                statusFilter === value ? 'bg-navy-900 text-white border-navy-900' : 'bg-white text-gray-600 border-gray-300 hover:border-navy-900'
              }`}>
              {label}
            </a>
          ))}
        </div>
      </div>

      <div className="bg-white rounded-lg border shadow-sm overflow-hidden">
        {items.length === 0 ? (
          <div className="py-16 text-center text-gray-400 text-sm">
            {statusFilter === 'pending'
              ? 'No outreach emails pending review.'
              : 'No items match the current filters.'}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50">
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase w-6">P</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Company</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Pitch</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Corridor</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Score</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Subject</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Status</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Actions</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {items.map(item => {
                const d = item.data as Record<string, unknown>;
                return (
                  <tr key={item.id} className={`hover:bg-gray-50 ${item.priority >= 3 ? 'bg-red-50/20' : ''}`}>
                    <td className="px-4 py-3">
                      <span className={`text-xs tabular-nums ${priorityColour(item.priority)}`}>{item.priority}</span>
                    </td>
                    <td className="px-4 py-3 font-medium">
                      {String(d.companyName ?? item.reviewPrompt?.match(/at (.+?) pitching/)?.[1] ?? '—')}
                    </td>
                    <td className="px-4 py-3">{pitchBadge(d.pitchAngle as string | null ?? null)}</td>
                    <td className="px-4 py-3 text-gray-500 text-xs">
                      {d.corridorSummary ? String(d.corridorSummary) : '—'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {d.leadQualityScore !== undefined && (
                        <span className="text-xs font-mono bg-gray-100 px-1.5 py-0.5 rounded">
                          {Number(d.leadQualityScore).toFixed(0)}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 max-w-xs">
                      <p className="text-gray-700 truncate text-xs" title={d.subject as string}>{d.subject as string ?? '—'}</p>
                      {d.bodyPreview != null && (
                        <p className="text-xs text-gray-400 mt-0.5 truncate">{String(d.bodyPreview).slice(0, 80)}…</p>
                      )}
                    </td>
                    <td className="px-4 py-3"><ReviewStatusBadge status={item.status} /></td>
                    <td className="px-4 py-3"><ReviewActions id={item.id} status={item.status} /></td>
                    <td className="px-4 py-3 text-right text-gray-400 text-xs">{relativeTime(item.createdAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <p className="text-xs text-gray-400 mt-3">
        Approving an item triggers a send via Resend. Human approval is required before any email is sent to a lead.
      </p>
    </div>
  );
}
