import { getCrawlers, getBrands, getSignals, getOpportunityScores, getBrandScores, getInsights, getLeads, getLeadPipeline } from '@/lib/api';
import { StatCard } from '@/components/StatCard';
import { StatusBadge } from '@/components/Badge';
import { relativeTime, sourceLabel } from '@/lib/utils';
import Link from 'next/link';

export default async function HomePage() {
  const [crawlersData, brandsData, signalsData, corridorData, brandScoreData, insightData, leadsData, pipelineData] = await Promise.all([
    getCrawlers().catch(() => ({ registered: [], recentJobs: [] })),
    getBrands({ limit: 100 }).catch(() => ({ brands: [], limit: 100, offset: 0 })),
    getSignals({ limit: 100 }).catch(() => ({ signals: [], limit: 100 })),
    getOpportunityScores({ limit: 100 }).catch(() => ({ scores: [], count: 0, limit: 100 })),
    getBrandScores({ limit: 200 }).catch(() => ({ scores: [], count: 0, limit: 200 })),
    getInsights({ limit: 50 }).catch(() => ({ insights: [], count: 0, limit: 50 })),
    getLeads({ limit: 200 }).catch(() => ({ leads: [], count: 0, limit: 200 })),
    getLeadPipeline().catch(() => ({ stages: [], totalLeads: 0, totalEstimatedValue: 0 })),
  ]);

  const euBrands        = brandsData.brands.filter((b) => b.euPresence).length;
  const brandsAbove80   = brandScoreData.scores.filter(s => s.compositeScore >= 80).length;
  const totalInsights   = insightData.insights.length;
  const approvedLeads   = leadsData.leads.filter(l => l.status === 'approved').length;
  const contactedLeads  = leadsData.leads.filter(l => ['contacted', 'replied', 'qualified', 'won'].includes(l.status)).length;
  const pipelineValue   = pipelineData.totalEstimatedValue;

  const latestJobs = Object.values(
    crawlersData.recentJobs.reduce<Record<string, (typeof crawlersData.recentJobs)[0]>>(
      (acc, job) => {
        if (!acc[job.crawlerType] || new Date(job.startedAt ?? 0) > new Date(acc[job.crawlerType].startedAt ?? 0)) {
          acc[job.crawlerType] = job;
        }
        return acc;
      },
      {},
    ),
  );

  return (
    <div className="p-8 max-w-6xl">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-navy-900">Overview</h1>
        <p className="text-gray-500 mt-1 text-sm">
          EU market intelligence pipeline · Phase 3 · Scoring & Insights
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mb-4">
        <StatCard label="Brands tracked" value={brandsData.brands.length} sub="US brands seeded" />
        <StatCard label="EU presence" value={euBrands} sub="brands already in EU" />
        <StatCard label="Market signals" value={signalsData.signals.length} sub="last 100 captured" />
        <StatCard label="Crawlers" value={crawlersData.registered.length} sub="registered" />
      </div>
      <div className="grid grid-cols-4 gap-4 mb-4">
        <StatCard label="Corridors scored" value={corridorData.scores.length} sub="category × country" />
        <StatCard label="Brands above 80" value={brandsAbove80} sub="outreach threshold" />
        <StatCard label="Brand×corridor pairs" value={brandScoreData.scores.length} sub="scored this run" />
        <StatCard label="Insights generated" value={totalInsights} sub="last 50 shown" />
      </div>
      <div className="grid grid-cols-4 gap-4 mb-8">
        <StatCard label="Total leads" value={leadsData.leads.length} sub="in pipeline" />
        <StatCard label="Approved for outreach" value={approvedLeads} sub="ready to send" />
        <StatCard label="Contacted / Active" value={contactedLeads} sub="replied or qualified" />
        <StatCard label="Pipeline value" value={pipelineValue > 0 ? `£${Math.round(pipelineValue / 1000)}K` : '—'} sub="est. total ACV" />
      </div>

      {/* Crawler status */}
      <div className="bg-white rounded-lg border shadow-sm">
        <div className="px-6 py-4 border-b flex items-center justify-between">
          <h2 className="font-semibold text-gray-800">Crawler Status</h2>
          <Link href="/crawl-jobs" className="text-xs text-gold-500 hover:underline">
            View all jobs →
          </Link>
        </div>
        {latestJobs.length === 0 ? (
          <div className="px-6 py-8 text-center text-gray-400 text-sm">
            No crawl jobs yet. Crawlers run on their scheduled cron, or trigger manually from the Crawl Jobs page.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50">
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Crawler</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Status</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Last run</th>
                <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase">Records</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {latestJobs.map((job) => (
                <tr key={job.id} className="hover:bg-gray-50">
                  <td className="px-6 py-3 font-medium">{job.crawlerType}</td>
                  <td className="px-6 py-3"><StatusBadge status={job.status} /></td>
                  <td className="px-6 py-3 text-gray-500">{relativeTime(job.startedAt)}</td>
                  <td className="px-6 py-3 text-right text-gray-700">{job.recordsFound ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Quick links */}
      <div className="grid grid-cols-3 gap-4 mt-6">
        {[
          { href: '/opportunities',     label: 'Opportunity Leaderboard', desc: 'Composite scores — corridors and brands ranked' },
          { href: '/insights-feed',     label: 'Insights Feed',           desc: 'AI-generated alerts, briefs, playbooks & reports' },
          { href: '/trends',            label: 'Detected Trends',         desc: 'Six-tier opportunity taxonomy across EU markets' },
          { href: '/gaps',              label: 'Gap Scores',              desc: 'Demand–supply opportunity leaderboard' },
          { href: '/trade-analytics',   label: 'Trade Analytics',         desc: 'Acceleration, market share & saturation risk' },
          { href: '/human-review',      label: 'Human Review',            desc: 'Approve/reject outreach before it sends' },
          { href: '/leads',             label: 'Lead Pipeline',           desc: 'Discovered leads scored for EU expansion outreach' },
          { href: '/outreach-queue',    label: 'Outreach Queue',          desc: 'Email campaigns pending human approval' },
          { href: '/lead-pipeline',     label: 'Sales Funnel',            desc: 'Pipeline stages from prospecting to closed' },
        ].map(({ href, label, desc }) => (
          <Link
            key={href}
            href={href}
            className="bg-white rounded-lg border shadow-sm p-5 hover:border-gold-500 transition-colors group"
          >
            <p className="font-semibold text-navy-900 group-hover:text-gold-500 transition-colors">{label}</p>
            <p className="text-xs text-gray-500 mt-1">{desc}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
