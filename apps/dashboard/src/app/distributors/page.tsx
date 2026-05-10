import { getDistributors } from '@/lib/api';
import { TriggerButton } from '@/components/TriggerButton';
import { Badge } from '@/components/Badge';

export const dynamic = 'force-dynamic';

export default async function DistributorsPage({
  searchParams,
}: {
  searchParams: { country?: string; category?: string; minScore?: string };
}) {
  const { country, category, minScore } = searchParams;
  const { distributors, count } = await getDistributors({
    country,
    category,
    minScore: minScore ? Number(minScore) : undefined,
    limit: 100,
  });

  const countries = [...new Set(distributors.map(d => d.countryCode))].sort();
  const categories = [...new Set(distributors.flatMap(d => d.categories ?? []))].sort();

  const avgScore = distributors.length > 0
    ? Math.round(distributors.reduce((s, d) => s + (d.distributorScore ?? 0), 0) / distributors.length)
    : 0;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">EU Distributor Network</h1>
          <p className="text-gray-400 text-sm mt-1">{count} distributors discovered across Europe</p>
        </div>
        <div className="flex gap-2">
          <TriggerButton agentType="distributor-discovery" label="Run Discovery" />
          <TriggerButton agentType="distributor-scoring" label="Score All" />
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-navy-800 rounded-lg p-4">
          <p className="text-gray-400 text-xs">Total Distributors</p>
          <p className="text-white text-2xl font-bold mt-1">{count}</p>
        </div>
        <div className="bg-navy-800 rounded-lg p-4">
          <p className="text-gray-400 text-xs">Countries Covered</p>
          <p className="text-white text-2xl font-bold mt-1">{countries.length}</p>
        </div>
        <div className="bg-navy-800 rounded-lg p-4">
          <p className="text-gray-400 text-xs">Avg Network Score</p>
          <p className="text-white text-2xl font-bold mt-1">{avgScore}</p>
        </div>
      </div>

      {/* Filters */}
      <form className="flex gap-3 flex-wrap">
        <select name="country" defaultValue={country ?? ''} className="bg-navy-800 border border-navy-700 text-white text-sm rounded px-3 py-1.5">
          <option value="">All Countries</option>
          {countries.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select name="category" defaultValue={category ?? ''} className="bg-navy-800 border border-navy-700 text-white text-sm rounded px-3 py-1.5">
          <option value="">All Categories</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select name="minScore" defaultValue={minScore ?? ''} className="bg-navy-800 border border-navy-700 text-white text-sm rounded px-3 py-1.5">
          <option value="">Min Score: Any</option>
          <option value="50">Score 50+</option>
          <option value="70">Score 70+</option>
          <option value="85">Score 85+</option>
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
              <th className="text-gray-400 font-medium pb-3 pr-4">Name</th>
              <th className="text-gray-400 font-medium pb-3 pr-4">Country</th>
              <th className="text-gray-400 font-medium pb-3 pr-4">Categories</th>
              <th className="text-gray-400 font-medium pb-3 pr-4">Score</th>
              <th className="text-gray-400 font-medium pb-3 pr-4">Contact</th>
              <th className="text-gray-400 font-medium pb-3">Source</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-navy-800">
            {distributors.map(d => (
              <tr key={d.id} className="hover:bg-navy-800/50">
                <td className="py-3 pr-4 font-medium text-white">
                  {d.websiteUrl ? (
                    <a href={d.websiteUrl} target="_blank" rel="noopener noreferrer" className="hover:text-gold-400">{d.name}</a>
                  ) : d.name}
                </td>
                <td className="py-3 pr-4 text-gray-300">{d.countryCode}</td>
                <td className="py-3 pr-4">
                  <div className="flex flex-wrap gap-1">
                    {(d.categories ?? []).slice(0, 3).map(cat => (
                      <Badge key={cat} variant="blue">{cat}</Badge>
                    ))}
                  </div>
                </td>
                <td className="py-3 pr-4">
                  <span className={`font-bold ${(d.distributorScore ?? 0) >= 70 ? 'text-green-400' : (d.distributorScore ?? 0) >= 40 ? 'text-yellow-400' : 'text-gray-400'}`}>
                    {d.distributorScore ?? '—'}
                  </span>
                </td>
                <td className="py-3 pr-4 text-gray-400">
                  {d.contactEmail ? (
                    <a href={`mailto:${d.contactEmail}`} className="hover:text-gold-400 truncate block max-w-[160px]">{d.contactEmail}</a>
                  ) : '—'}
                </td>
                <td className="py-3 text-gray-500 text-xs">{d.discoverySource ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {distributors.length === 0 && (
          <p className="text-gray-500 text-sm text-center py-8">No distributors found. Run discovery to populate.</p>
        )}
      </div>
    </div>
  );
}
