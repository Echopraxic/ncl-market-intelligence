import { getCrawlJobs, getCrawlers } from '@/lib/api';
import { StatusBadge } from '@/components/Badge';
import { TriggerButton } from '@/components/TriggerButton';
import { formatDateTime, relativeTime, durationSeconds } from '@/lib/utils';

type SearchParams = Promise<{ crawlerType?: string }>;

const CRAWLER_DESCRIPTIONS: Record<string, string> = {
  'trade-show':    'Scrapes trade show metadata and exhibitor lists',
  'shopify-brand': 'Seeds brand catalog from Shopify storefronts',
  'google-trends': 'Fetches EU trend data via pytrends',
  'amazon-eu':     'Captures Amazon EU bestseller and new-release signals',
};

export default async function CrawlJobsPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const typeFilter = params.crawlerType ?? '';

  const [crawlersData, jobsData] = await Promise.all([
    getCrawlers().catch(() => ({ registered: [], recentJobs: [] })),
    getCrawlJobs({
      ...(typeFilter ? { crawlerType: typeFilter } : {}),
      limit: 50,
    }).catch(() => ({ jobs: [] })),
  ]);

  // Latest job per crawler type
  const latestByType = crawlersData.registered.reduce<Record<string, typeof jobsData.jobs[0] | undefined>>(
    (acc, type) => {
      acc[type] = crawlersData.recentJobs.find((j) => j.crawlerType === type);
      return acc;
    },
    {},
  );

  const completed = jobsData.jobs.filter((j) => j.status === 'completed').length;
  const failed = jobsData.jobs.filter((j) => j.status === 'failed').length;
  const running = jobsData.jobs.filter((j) => j.status === 'running').length;

  return (
    <div className="p-8 max-w-6xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-navy-900">Crawl Jobs</h1>
        <p className="text-gray-500 mt-1 text-sm">Monitor and trigger data collection crawlers</p>
      </div>

      {/* Crawler overview cards */}
      <div className="grid grid-cols-2 gap-4 mb-8">
        {crawlersData.registered.map((type) => {
          const latest = latestByType[type];
          return (
            <div key={type} className="bg-white rounded-lg border shadow-sm p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-navy-900 text-sm">{type}</p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {CRAWLER_DESCRIPTIONS[type] ?? 'Data collection crawler'}
                  </p>
                </div>
                <TriggerButton crawlerType={type} />
              </div>

              <div className="mt-4 grid grid-cols-3 gap-3 text-xs">
                <div>
                  <p className="text-gray-400">Status</p>
                  <div className="mt-1">
                    {latest ? <StatusBadge status={latest.status} /> : <span className="text-gray-300">Never run</span>}
                  </div>
                </div>
                <div>
                  <p className="text-gray-400">Last run</p>
                  <p className="mt-1 text-gray-700">{relativeTime(latest?.startedAt)}</p>
                </div>
                <div>
                  <p className="text-gray-400">Records</p>
                  <p className="mt-1 text-gray-700 font-medium">{latest?.recordsFound ?? '—'}</p>
                </div>
              </div>

              {latest?.errorLog && (
                <div className="mt-3 bg-red-50 border border-red-200 rounded p-2">
                  <p className="text-xs text-red-700 font-mono truncate">{latest.errorLog.slice(0, 120)}</p>
                </div>
              )}
            </div>
          );
        })}

        {crawlersData.registered.length === 0 && (
          <div className="col-span-2 bg-white rounded-lg border shadow-sm py-12 text-center text-gray-400 text-sm">
            No crawlers registered. Start the API server to register crawlers.
          </div>
        )}
      </div>

      {/* Job history */}
      <div className="bg-white rounded-lg border shadow-sm">
        <div className="px-6 py-4 border-b flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-gray-800">Recent Job History</h2>
            <p className="text-xs text-gray-400 mt-0.5">
              {completed} completed · {failed} failed · {running} running
            </p>
          </div>

          {/* Type filter links */}
          <div className="flex gap-1">
            <a
              href="/crawl-jobs"
              className={`px-3 py-1 rounded text-xs border transition-colors ${
                !typeFilter
                  ? 'bg-navy-900 text-white border-navy-900'
                  : 'text-gray-600 border-gray-300 hover:border-navy-900'
              }`}
            >
              All
            </a>
            {crawlersData.registered.map((type) => (
              <a
                key={type}
                href={`/crawl-jobs?crawlerType=${type}`}
                className={`px-3 py-1 rounded text-xs border transition-colors ${
                  typeFilter === type
                    ? 'bg-navy-900 text-white border-navy-900'
                    : 'text-gray-600 border-gray-300 hover:border-navy-900'
                }`}
              >
                {type}
              </a>
            ))}
          </div>
        </div>

        {jobsData.jobs.length === 0 ? (
          <div className="py-12 text-center text-gray-400 text-sm">
            No job history yet.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50">
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Crawler</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Status</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Started</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase">Duration</th>
                <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase">Records</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {jobsData.jobs.map((job) => (
                <tr key={job.id} className="hover:bg-gray-50">
                  <td className="px-6 py-3 font-medium text-navy-900">{job.crawlerType}</td>
                  <td className="px-6 py-3"><StatusBadge status={job.status} /></td>
                  <td className="px-6 py-3 text-gray-500 text-xs">{formatDateTime(job.startedAt)}</td>
                  <td className="px-6 py-3 text-gray-500">
                    {durationSeconds(job.startedAt, job.completedAt)}
                  </td>
                  <td className="px-6 py-3 text-right font-medium text-gray-700">
                    {job.recordsFound ?? '—'}
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
