import { getDistributorMatches } from '@/lib/api';
import { TriggerButton } from '@/components/TriggerButton';
import { Badge } from '@/components/Badge';

export const dynamic = 'force-dynamic';

const STATUS_COLORS: Record<string, string> = {
  suggested: 'text-blue-400',
  pitched: 'text-yellow-400',
  connected: 'text-green-400',
  rejected: 'text-red-400',
};

const PROXIMITY_STYLES: Record<string, { label: string; className: string }> = {
  exact:    { label: 'Direct competitor',  className: 'bg-red-500/20 text-red-400 border border-red-500/30' },
  adjacent: { label: 'Adjacent brands',    className: 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30' },
};

export default async function DistributorMatchesPage({
  searchParams,
}: {
  searchParams: { status?: string; minScore?: string; proximity?: string };
}) {
  const { status, minScore, proximity } = searchParams;
  const { matches, count } = await getDistributorMatches({
    status: status as 'suggested' | 'pitched' | 'connected' | 'rejected' | undefined,
    minScore: minScore ? Number(minScore) : undefined,
    limit: 100,
  });

  const filtered = proximity
    ? matches.filter(m => m.competitorProximity === proximity)
    : matches;

  const avgScore = filtered.length > 0
    ? Math.round(filtered.reduce((s, m) => s + (m.matchScore ?? 0), 0) / filtered.length * 100)
    : 0;

  const connected    = filtered.filter(m => m.status === 'connected').length;
  const exactCount   = matches.filter(m => m.competitorProximity === 'exact').length;
  const adjacentCount = matches.filter(m => m.competitorProximity === 'adjacent').length;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">Brand–Distributor Matches</h1>
          <p className="text-gray-400 text-sm mt-1">{count} match suggestions</p>
        </div>
        <div className="flex gap-2">
          <TriggerButton agentType="distributor-matching" label="Run Matching" />
          <TriggerButton agentType="competitor-intel" label="Run Intel" />
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-5 gap-4">
        <div className="bg-navy-800 rounded-lg p-4">
          <p className="text-gray-400 text-xs">Total Matches</p>
          <p className="text-white text-2xl font-bold mt-1">{count}</p>
        </div>
        <div className="bg-navy-800 rounded-lg p-4">
          <p className="text-gray-400 text-xs">Avg Match Score</p>
          <p className="text-white text-2xl font-bold mt-1">{avgScore}%</p>
        </div>
        <div className="bg-navy-800 rounded-lg p-4">
          <p className="text-gray-400 text-xs">Connected</p>
          <p className="text-white text-2xl font-bold mt-1 text-green-400">{connected}</p>
        </div>
        <div className="bg-navy-800 rounded-lg p-4">
          <p className="text-gray-400 text-xs">Direct Competitors</p>
          <p className="text-white text-2xl font-bold mt-1 text-red-400">{exactCount}</p>
        </div>
        <div className="bg-navy-800 rounded-lg p-4">
          <p className="text-gray-400 text-xs">Adjacent Brands</p>
          <p className="text-white text-2xl font-bold mt-1 text-yellow-400">{adjacentCount}</p>
        </div>
      </div>

      {/* Filters */}
      <form className="flex gap-3 flex-wrap">
        <select name="status" defaultValue={status ?? ''} className="bg-navy-800 border border-navy-700 text-white text-sm rounded px-3 py-1.5">
          <option value="">All Statuses</option>
          <option value="suggested">Suggested</option>
          <option value="pitched">Pitched</option>
          <option value="connected">Connected</option>
          <option value="rejected">Rejected</option>
        </select>
        <select name="minScore" defaultValue={minScore ?? ''} className="bg-navy-800 border border-navy-700 text-white text-sm rounded px-3 py-1.5">
          <option value="">Min Score: Any</option>
          <option value="0.5">50%+</option>
          <option value="0.65">65%+</option>
          <option value="0.8">80%+</option>
        </select>
        <select name="proximity" defaultValue={proximity ?? ''} className="bg-navy-800 border border-navy-700 text-white text-sm rounded px-3 py-1.5">
          <option value="">All Intel</option>
          <option value="exact">Direct competitors only</option>
          <option value="adjacent">Adjacent brands only</option>
        </select>
        <button type="submit" className="bg-gold-500 text-navy-900 text-sm font-medium px-4 py-1.5 rounded hover:bg-gold-400">
          Filter
        </button>
      </form>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-navy-700 text-left">
              <th className="text-gray-400 font-medium pb-3 pr-4">Brand / Lead</th>
              <th className="text-gray-400 font-medium pb-3 pr-4">Distributor</th>
              <th className="text-gray-400 font-medium pb-3 pr-4">Country</th>
              <th className="text-gray-400 font-medium pb-3 pr-4">Match Score</th>
              <th className="text-gray-400 font-medium pb-3 pr-4">Competitor Intel</th>
              <th className="text-gray-400 font-medium pb-3 pr-4">Reasons</th>
              <th className="text-gray-400 font-medium pb-3">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-navy-800">
            {filtered.map(m => {
              const prox = m.competitorProximity ? PROXIMITY_STYLES[m.competitorProximity] : null;
              return (
                <tr key={m.id} className="hover:bg-navy-800/50">
                  <td className="py-3 pr-4 text-white font-medium">{m.leadCompany ?? '—'}</td>
                  <td className="py-3 pr-4 text-gray-300">{m.distributorName}</td>
                  <td className="py-3 pr-4 text-gray-400">{m.countryCode}</td>
                  <td className="py-3 pr-4">
                    <div className="flex items-center gap-2">
                      <div className="w-16 bg-navy-700 rounded-full h-1.5">
                        <div
                          className={`h-1.5 rounded-full ${(m.matchScore ?? 0) >= 0.7 ? 'bg-green-400' : (m.matchScore ?? 0) >= 0.5 ? 'bg-yellow-400' : 'bg-gray-500'}`}
                          style={{ width: `${Math.round((m.matchScore ?? 0) * 100)}%` }}
                        />
                      </div>
                      <span className="text-gray-300 font-mono text-xs">
                        {((m.matchScore ?? 0) * 100).toFixed(0)}%
                      </span>
                    </div>
                  </td>
                  <td className="py-3 pr-4">
                    {prox ? (
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${prox.className}`}>
                        {prox.label}{m.competitorCount ? ` ×${m.competitorCount}` : ''}
                      </span>
                    ) : (
                      <span className="text-gray-600 text-xs">—</span>
                    )}
                  </td>
                  <td className="py-3 pr-4">
                    <div className="flex flex-wrap gap-1">
                      {(m.matchReasons ?? []).map(r => (
                        <Badge key={r} variant="blue">{r.replace('_', ' ')}</Badge>
                      ))}
                    </div>
                  </td>
                  <td className="py-3">
                    <span className={`text-xs font-medium ${STATUS_COLORS[m.status] ?? 'text-gray-400'}`}>
                      {m.status}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <p className="text-gray-500 text-sm text-center py-8">No matches found. Run distributor matching then competitor intel to populate.</p>
        )}
      </div>
    </div>
  );
}
