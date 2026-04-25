import { getHumanReview } from '@/lib/api';
import { ReviewStatusBadge } from '@/components/Badge';
import { StatCard } from '@/components/StatCard';
import { relativeTime } from '@/lib/utils';
import { ReviewActions } from './ReviewActions';

type SearchParams = Promise<{
  type?: string;
  status?: string;
}>;

const TYPES = [
  { value: '',             label: 'All types'   },
  { value: 'trend',        label: 'Trends'      },
  { value: 'outreach',     label: 'Outreach'    },
  { value: 'insight',      label: 'Insights'    },
];

const STATUSES = [
  { value: '',         label: 'All'      },
  { value: 'pending',  label: 'Pending'  },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
];

const PRIORITY_LABELS: Record<number, string> = {
  3: 'High',
  2: 'Medium',
  1: 'Low',
};

function priorityColour(p: number) {
  if (p >= 3) return 'text-red-600 font-semibold';
  if (p === 2) return 'text-amber-600 font-medium';
  return 'text-gray-400';
}

export default async function HumanReviewPage({ searchParams }: { searchParams: SearchParams }) {
  const params     = await searchParams;
  const typeFilter = params.type   ?? '';
  const statusFilter = params.status ?? 'pending';

  const data = await getHumanReview({
    ...(typeFilter   ? { type: typeFilter }     : {}),
    ...(statusFilter ? { status: statusFilter } : {}),
    limit: 100,
  }).catch(() => ({ items: [], count: 0, limit: 100 }));

  const items = data.items;

  const pendingCount  = items.filter(i => i.status === 'pending').length;
  const approvedCount = items.filter(i => i.status === 'approved').length;
  const rejectedCount = items.filter(i => i.status === 'rejected').length;
  const highPriority  = items.filter(i => i.priority >= 3).length;

  function filterUrl(updates: Record<string, string>) {
    const merged = { type: typeFilter, status: statusFilter, ...updates };
    const q = new URLSearchParams(
      Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== '')),
    ).toString();
    return `/human-review${q ? `?${q}` : ''}`;
  }

  return (
    <div className="p-8 max-w-6xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-navy-900">Human Review Queue</h1>
        <p className="text-gray-500 mt-1 text-sm">
          Approve or reject items before they proceed through the pipeline. Outreach emails require approval before sending.
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard label="Pending" value={pendingCount} sub="awaiting decision" />
        <StatCard label="High priority" value={highPriority} sub="P3 items" />
        <StatCard label="Approved" value={approvedCount} sub="in current view" />
        <StatCard label="Rejected" value={rejectedCount} sub="in current view" />
      </div>

      {/* Filters */}
      <div className="bg-white rounded-lg border shadow-sm p-4 mb-6 flex flex-wrap items-center gap-6">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 font-medium">Type:</span>
          <div className="flex gap-1">
            {TYPES.map(({ value, label }) => (
              <a key={value} href={filterUrl({ type: value })}
                className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                  typeFilter === value
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
                  statusFilter === value
                    ? 'bg-navy-900 text-white border-navy-900'
                    : 'bg-white text-gray-600 border-gray-300 hover:border-navy-900'
                }`}>
                {label}
              </a>
            ))}
          </div>
        </div>
      </div>

      {/* Queue table */}
      <div className="bg-white rounded-lg border shadow-sm overflow-hidden">
        {items.length === 0 ? (
          <div className="py-16 text-center text-gray-400 text-sm">
            {statusFilter === 'pending'
              ? 'No items pending review.'
              : 'No items match the current filters.'}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50">
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase w-6">P</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Type</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Prompt</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Status</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Actions</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Reviewed by</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {items.map(item => (
                <tr key={item.id} className={`hover:bg-gray-50 ${item.priority >= 3 ? 'bg-red-50/20' : ''}`}>
                  <td className="px-4 py-3">
                    <span className={`text-xs tabular-nums ${priorityColour(item.priority)}`}
                      title={PRIORITY_LABELS[item.priority] ?? String(item.priority)}>
                      {item.priority}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-700 font-mono">
                      {item.type}
                    </span>
                  </td>
                  <td className="px-4 py-3 max-w-sm">
                    <p className="text-gray-700 truncate" title={item.reviewPrompt ?? undefined}>
                      {item.reviewPrompt ?? <span className="text-gray-400 italic">No prompt</span>}
                    </p>
                    {item.data && Object.keys(item.data).length > 0 && (
                      <p className="text-xs text-gray-400 mt-0.5 truncate">
                        {Object.entries(item.data).slice(0, 3).map(([k, v]) => `${k}: ${String(v).slice(0, 30)}`).join(' · ')}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <ReviewStatusBadge status={item.status} />
                  </td>
                  <td className="px-4 py-3">
                    <ReviewActions id={item.id} status={item.status} />
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs">
                    {item.reviewedBy
                      ? <span>{item.reviewedBy} · {relativeTime(item.reviewedAt)}</span>
                      : <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-400 text-xs">
                    {relativeTime(item.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="text-xs text-gray-400 mt-3">
        Priority: 3 = High (outreach emails), 2 = Medium (insights), 1 = Low (informational).
        Approving an outreach item queues the email for sending — it does not send immediately.
      </p>
    </div>
  );
}
