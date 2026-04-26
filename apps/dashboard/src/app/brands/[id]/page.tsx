import { getBrand } from '@/lib/api';
import { Badge, StatusBadge } from '@/components/Badge';
import { formatDate, sourceLabel, countryFlag } from '@/lib/utils';
import Link from 'next/link';
import { notFound } from 'next/navigation';

type PageProps = { params: Promise<{ id: string }> };

function scoreColor(score: number): string {
  if (score >= 80) return 'text-green-700 font-bold';
  if (score >= 60) return 'text-amber-700 font-semibold';
  return 'text-gray-500';
}

function ScoreBar({ value, max = 100 }: { value: number; max?: number }) {
  const pct = Math.round((value / max) * 100);
  const color = value >= 80 ? 'bg-green-500' : value >= 60 ? 'bg-amber-400' : 'bg-gray-300';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`text-xs w-8 text-right ${scoreColor(value)}`}>{Math.round(value)}</span>
    </div>
  );
}

export default async function BrandDetailPage({ params }: PageProps) {
  const { id } = await params;

  const data = await getBrand(id).catch(() => null);
  if (!data) notFound();

  const { brand, scores, lead, recentSignals } = data;

  const topScore = scores[0] ?? null;
  const signalsBySource = recentSignals.reduce<Record<string, typeof recentSignals>>((acc, s) => {
    if (!acc[s.source]) acc[s.source] = [];
    acc[s.source].push(s);
    return acc;
  }, {});

  return (
    <div className="p-8 max-w-6xl">
      {/* Breadcrumb */}
      <div className="mb-4 text-xs text-gray-400">
        <Link href="/brands" className="hover:text-navy-900">Brands</Link>
        <span className="mx-1">/</span>
        <span className="text-gray-600">{brand.name}</span>
      </div>

      {/* Header card */}
      <div className="bg-white rounded-xl border shadow-sm p-6 mb-6">
        <div className="flex items-start justify-between gap-6">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <h1 className="text-2xl font-bold text-navy-900">{brand.name}</h1>
              <Badge variant={brand.euPresence ? 'green' : 'gray'}>
                {brand.euPresence ? 'EU ✓' : 'No EU presence'}
              </Badge>
            </div>
            <p className="text-sm text-gray-500">
              {brand.country ?? 'Unknown country'}
              {brand.employeeCount ? ` · ${brand.employeeCount.toLocaleString()} employees` : ''}
              {brand.annualRevenueEstimate
                ? ` · $${(brand.annualRevenueEstimate / 1_000_000).toFixed(1)}M est. revenue`
                : ''}
            </p>
            {brand.websiteUrl && (
              <a
                href={brand.websiteUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-blue-600 hover:underline mt-1 inline-block"
              >
                {brand.websiteUrl.replace(/^https?:\/\//, '')}
              </a>
            )}
          </div>

          {topScore && (
            <div className="text-right shrink-0">
              <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">Top Composite Score</p>
              <p className={`text-3xl ${scoreColor(topScore.compositeScore)}`}>
                {Math.round(topScore.compositeScore)}
              </p>
              <p className="text-xs text-gray-400 mt-0.5">
                {topScore.category} · {countryFlag(topScore.countryCode)}
              </p>
            </div>
          )}
        </div>

        {brand.categories && brand.categories.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-4">
            {brand.categories.map((cat) => (
              <span key={cat} className="text-xs bg-navy-50 text-navy-700 border border-navy-100 px-2 py-0.5 rounded-full">
                {cat}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-3 gap-6">
        {/* EU Corridor Scores (2/3 width) */}
        <div className="col-span-2 space-y-4">
          <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b">
              <h2 className="font-semibold text-gray-800">EU Corridor Scores</h2>
              <p className="text-xs text-gray-400 mt-0.5">Composite opportunity scores per market corridor</p>
            </div>

            {scores.length === 0 ? (
              <div className="py-10 text-center text-gray-400 text-sm">
                No scores yet — run Brand Fit Scoring to generate corridor scores.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-gray-50">
                    <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Category</th>
                    <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Market</th>
                    <th className="px-6 py-3 text-xs font-medium text-gray-500 uppercase">Composite</th>
                    <th className="px-6 py-3 text-xs font-medium text-gray-500 uppercase">Category</th>
                    <th className="px-6 py-3 text-xs font-medium text-gray-500 uppercase">Brand Fit</th>
                    <th className="px-6 py-3 text-xs font-medium text-gray-500 uppercase">NI Score</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {scores.map((s) => (
                    <tr key={s.id} className="hover:bg-gray-50">
                      <td className="px-6 py-3 font-medium text-navy-900">{s.category}</td>
                      <td className="px-6 py-3 text-gray-600">{countryFlag(s.countryCode)} {s.countryCode}</td>
                      <td className="px-6 py-3">
                        <ScoreBar value={s.compositeScore} />
                      </td>
                      <td className="px-6 py-3">
                        <ScoreBar value={s.categoryOpportunityScore} />
                      </td>
                      <td className="px-6 py-3">
                        <ScoreBar value={s.brandFitScore} />
                      </td>
                      <td className="px-6 py-3">
                        <ScoreBar value={s.niSuitabilityPreScore} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Recent Signals */}
          <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b">
              <h2 className="font-semibold text-gray-800">Market Signals</h2>
              <p className="text-xs text-gray-400 mt-0.5">Recent EU market signals matching this brand's categories</p>
            </div>

            {recentSignals.length === 0 ? (
              <div className="py-10 text-center text-gray-400 text-sm">
                No signals yet for this brand's categories.
              </div>
            ) : (
              <div className="divide-y">
                {Object.entries(signalsBySource).map(([source, signals]) => (
                  <div key={source} className="px-6 py-4">
                    <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
                      {sourceLabel(source)}
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                      {signals.slice(0, 6).map((sig) => (
                        <div key={sig.id} className="flex items-center justify-between bg-gray-50 rounded px-3 py-2 text-xs">
                          <div>
                            <span className="font-medium text-gray-700">{sig.category}</span>
                            <span className="text-gray-400 ml-1">· {countryFlag(sig.countryCode)}</span>
                          </div>
                          <div className="text-right">
                            <span className={`font-mono font-bold ${sig.signalValue >= 70 ? 'text-green-700' : sig.signalValue >= 40 ? 'text-amber-600' : 'text-gray-500'}`}>
                              {sig.signalValue}
                            </span>
                            <span className="text-gray-400 ml-1">{formatDate(sig.capturedAt)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right sidebar — Lead Pipeline */}
        <div className="space-y-4">
          <div className="bg-white rounded-xl border shadow-sm p-5">
            <h2 className="font-semibold text-gray-800 mb-4">Lead Pipeline</h2>

            {!lead ? (
              <div className="text-center py-6">
                <p className="text-sm text-gray-400">Not yet in lead pipeline</p>
                <p className="text-xs text-gray-300 mt-1">Run Lead Discovery to add this brand</p>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-500">Status</span>
                  <StatusBadge status={lead.status} />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-500">Quality score</span>
                  <span className={`text-sm font-bold ${scoreColor(lead.leadQualityScore)}`}>
                    {lead.leadQualityScore}
                  </span>
                </div>
                {lead.opportunityScore && (
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-500">Opportunity</span>
                    <span className="text-sm font-semibold text-gray-700">{lead.opportunityScore}</span>
                  </div>
                )}
                {lead.bestCategory && (
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-500">Best category</span>
                    <span className="text-xs text-navy-900 font-medium">{lead.bestCategory}</span>
                  </div>
                )}
                {lead.trendTier && (
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-500">Trend tier</span>
                    <Badge variant={lead.trendTier === 'breakthrough' ? 'green' : lead.trendTier === 'accelerating' ? 'gold' : 'gray'}>
                      {lead.trendTier}
                    </Badge>
                  </div>
                )}
                {lead.pitchSummary && (
                  <div className="mt-3 bg-blue-50 rounded p-3 text-xs text-blue-800 leading-relaxed">
                    {lead.pitchSummary}
                  </div>
                )}
                {lead.contactName && (
                  <div className="mt-3 border-t pt-3">
                    <p className="text-xs font-medium text-gray-700">{lead.contactName}</p>
                    {lead.email && (
                      <a href={`mailto:${lead.email}`} className="text-xs text-blue-600 hover:underline">
                        {lead.email}
                      </a>
                    )}
                  </div>
                )}
                <div className="mt-3 pt-3 border-t">
                  <Link href="/leads" className="text-xs text-navy-900 hover:underline">
                    View in leads pipeline →
                  </Link>
                </div>
              </div>
            )}
          </div>

          {/* Brand metadata */}
          <div className="bg-white rounded-xl border shadow-sm p-5">
            <h2 className="font-semibold text-gray-800 mb-4">Brand Info</h2>
            <div className="space-y-2 text-xs">
              {brand.shopifyStoreUrl && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Shopify</span>
                  <a href={brand.shopifyStoreUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline truncate max-w-32">
                    {brand.shopifyStoreUrl.replace(/^https?:\/\//, '')}
                  </a>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-gray-500">Added</span>
                <span className="text-gray-700">{formatDate(brand.createdAt)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Updated</span>
                <span className="text-gray-700">{formatDate(brand.updatedAt)}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
