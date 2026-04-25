import { getLeads } from '@/lib/api';
import type { Lead, LeadStatus } from '@/lib/api';
import { StatCard } from '@/components/StatCard';
import { TriggerButton } from '@/components/TriggerButton';

type SearchParams = Promise<{
  status?: string;
  source?: string;
  minScore?: string;
  category?: string;
}>;

const STATUS_OPTS: Array<{ value: string; label: string }> = [
  { value: '', label: 'All' },
  { value: 'new', label: 'New' },
  { value: 'reviewed', label: 'Reviewed' },
  { value: 'approved', label: 'Approved' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'replied', label: 'Replied' },
  { value: 'qualified', label: 'Qualified' },
  { value: 'won', label: 'Won' },
  { value: 'lost', label: 'Lost' },
];

const SCORE_THRESHOLDS = [
  { value: '', label: 'All' },
  { value: '50', label: '50+' },
  { value: '70', label: '70+' },
  { value: '80', label: '80+' },
];

function scoreBg(score: number) {
  if (score >= 80) return 'bg-green-100 text-green-800';
  if (score >= 60) return 'bg-blue-100 text-blue-800';
  if (score >= 40) return 'bg-amber-100 text-amber-700';
  return 'bg-gray-100 text-gray-600';
}

function pitchBadge(angle: string | null) {
  const labels: Record<string, string> = {
    first_mover:      'First Mover',
    unmet_demand:     'Unmet Demand',
    cost_optimisation:'Cost Optimisation',
    margin_expansion: 'Margin Expansion',
  };
  const colours: Record<string, string> = {
    first_mover:      'bg-purple-100 text-purple-800',
    unmet_demand:     'bg-blue-100 text-blue-800',
    cost_optimisation:'bg-green-100 text-green-800',
    margin_expansion: 'bg-amber-100 text-amber-800',
  };
  if (!angle) return null;
  return (
    <span className={`inline-block text-xs px-2 py-0.5 rounded-full font-medium ${colours[angle] ?? 'bg-gray-100 text-gray-600'}`}>
      {labels[angle] ?? angle}
    </span>
  );
}

function statusBadge(status: LeadStatus) {
  const colours: Record<string, string> = {
    new:       'bg-gray-100 text-gray-600',
    reviewed:  'bg-yellow-100 text-yellow-800',
    approved:  'bg-blue-100 text-blue-800',
    contacted: 'bg-purple-100 text-purple-800',
    replied:   'bg-indigo-100 text-indigo-800',
    qualified: 'bg-green-100 text-green-800',
    won:       'bg-emerald-100 text-emerald-800',
    lost:      'bg-red-100 text-red-700',
    invalid:   'bg-gray-100 text-gray-400',
  };
  return (
    <span className={`inline-block text-xs px-2 py-0.5 rounded-full font-medium capitalize ${colours[status] ?? 'bg-gray-100 text-gray-600'}`}>
      {status}
    </span>
  );
}

export default async function LeadsPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const status   = params.status   ?? '';
  const source   = params.source   ?? '';
  const minScore = params.minScore ?? '';
  const category = params.category ?? '';

  const data = await getLeads({
    ...(status   ? { status: status as LeadStatus }             : {}),
    ...(source   ? { source }                                   : {}),
    ...(minScore ? { minScore: parseFloat(minScore) }           : {}),
    ...(category ? { category }                                 : {}),
    limit: 100,
  }).catch(() => ({ leads: [] as Lead[], count: 0, limit: 100 }));

  const leads = data.leads;
  const approved  = leads.filter(l => l.status === 'approved').length;
  const contacted = leads.filter(l => l.status === 'contacted').length;
  const replied   = leads.filter(l => ['replied', 'qualified'].includes(l.status)).length;
  const avgScore  = leads.length
    ? (leads.reduce((s, l) => s + l.leadQualityScore, 0) / leads.length).toFixed(0)
    : '—';

  function filterUrl(updates: Record<string, string>) {
    const merged = { status, source, minScore, category, ...updates };
    const q = new URLSearchParams(
      Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== '')),
    ).toString();
    return `/leads${q ? `?${q}` : ''}`;
  }

  return (
    <div className="p-8 max-w-7xl">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-navy-900">Lead Pipeline</h1>
          <p className="text-gray-500 mt-1 text-sm">Discovered leads scored and ranked for EU expansion outreach</p>
        </div>
        <div className="flex gap-2">
          <TriggerButton agentType="lead-discovery" label="Discover" />
          <TriggerButton agentType="lead-scoring" label="Score" />
          <TriggerButton agentType="pitch-angles" label="Pitch Angles" />
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatCard label="Total leads" value={leads.length} sub="matching filters" />
        <StatCard label="Approved" value={approved} sub="ready for outreach" />
        <StatCard label="Contacted" value={contacted} sub="emails sent" />
        <StatCard label="Replied / Qualified" value={replied} sub="active pipeline" />
      </div>

      {/* Filters */}
      <div className="bg-white rounded-lg border shadow-sm p-4 mb-6 flex flex-wrap items-center gap-6">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 font-medium">Status:</span>
          <div className="flex gap-1 flex-wrap">
            {STATUS_OPTS.map(({ value, label }) => (
              <a key={value} href={filterUrl({ status: value })}
                className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                  status === value ? 'bg-navy-900 text-white border-navy-900' : 'bg-white text-gray-600 border-gray-300 hover:border-navy-900'
                }`}>
                {label}
              </a>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 font-medium">Min score:</span>
          <div className="flex gap-1">
            {SCORE_THRESHOLDS.map(({ value, label }) => (
              <a key={value} href={filterUrl({ minScore: value })}
                className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                  minScore === value ? 'bg-navy-900 text-white border-navy-900' : 'bg-white text-gray-600 border-gray-300 hover:border-navy-900'
                }`}>
                {label}
              </a>
            ))}
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg border shadow-sm overflow-hidden">
        {leads.length === 0 ? (
          <div className="py-16 text-center text-gray-400 text-sm">
            No leads yet. Run Lead Discovery to populate data.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50">
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Company</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Source</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Category</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Market</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase">Score</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Pitch</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Status</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase">Contact</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {leads.map((lead) => (
                <tr key={lead.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium">
                    {lead.websiteUrl ? (
                      <a href={lead.websiteUrl} target="_blank" rel="noopener noreferrer" className="text-blue-700 hover:underline">
                        {lead.companyName}
                      </a>
                    ) : lead.companyName}
                    {lead.euPresence && <span className="ml-1.5 text-xs text-gray-400">(EU present)</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs capitalize">{lead.discoverySource.replace(/_/g, ' ')}</td>
                  <td className="px-4 py-3 text-gray-600">{lead.bestCategory ? lead.bestCategory.replace(/_/g, ' ') : '—'}</td>
                  <td className="px-4 py-3 text-gray-600">{lead.bestCountryCode ?? '—'}</td>
                  <td className="px-4 py-3 text-right">
                    <span className={`text-xs px-2 py-0.5 rounded font-mono font-semibold ${scoreBg(lead.leadQualityScore)}`}>
                      {lead.leadQualityScore.toFixed(0)}
                    </span>
                  </td>
                  <td className="px-4 py-3">{pitchBadge(lead.pitchAngle)}</td>
                  <td className="px-4 py-3">{statusBadge(lead.status)}</td>
                  <td className="px-4 py-3 text-gray-400 text-xs">
                    {lead.email ? '✉' : ''}{lead.linkedinUrl ? ' 🔗' : ''}
                    {!lead.email && !lead.linkedinUrl && '—'}
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
