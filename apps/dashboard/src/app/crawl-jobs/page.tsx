import React from 'react';
import { getCrawlJobs, getCrawlers, type CrawlJob, type StructuredCrawlError } from '@/lib/api';
import { StatusBadge } from '@/components/Badge';
import { TriggerButton } from '@/components/TriggerButton';
import { formatDateTime, relativeTime, formatDurationMs } from '@/lib/utils';
import { RunningPoller } from './RunningPoller';

type SearchParams = Promise<{ crawlerType?: string }>;

const CRAWLER_DESCRIPTIONS: Record<string, string> = {
  'trade-show':    'Scrapes trade show metadata and exhibitor lists',
  'shopify-brand': 'Seeds and updates brand catalog from Shopify storefronts',
  'google-trends': 'Fetches EU trend data across categories and countries',
  'amazon-eu':     'Captures Amazon EU bestseller and new-release signals',
  'cpg-directory': 'Scrapes CPG brand directories (cpgd.xyz, BevNet)',
  'faire':         'Crawls Faire wholesale marketplace brand directory',
  'thingtesting':  'Scrapes ThingTesting DTC product reviews and brand data',
  'bulletin':      'Crawls Bulletin wholesale marketplace for indie brands',
};

function borderClass(status: CrawlJob['status'] | undefined): string {
  switch (status) {
    case 'completed': return 'border-l-4 border-l-green-400';
    case 'failed':    return 'border-l-4 border-l-red-400';
    case 'running':   return 'border-l-4 border-l-blue-400';
    default:          return 'border-l-4 border-l-gray-200';
  }
}

function durationColor(ms: number | null): string {
  if (ms == null) return 'text-gray-400';
  if (ms < 30_000)  return 'text-green-600';
  if (ms < 120_000) return 'text-amber-600';
  return 'text-red-600';
}

function FreshnessChip({ lastFreshAt }: { lastFreshAt: string | null | undefined }) {
  if (!lastFreshAt) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-gray-400">
        <span className="w-1.5 h-1.5 rounded-full bg-gray-300 inline-block" />
        No new data yet
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-50 border border-green-200 rounded px-2 py-0.5">
      <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
      Fresh {relativeTime(lastFreshAt)}
    </span>
  );
}

export default async function CrawlJobsPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const typeFilter = params.crawlerType ?? '';

  const [crawlersData, jobsData] = await Promise.all([
    getCrawlers().catch(() => ({ registered: [], recentJobs: [] })),
    getCrawlJobs({ ...(typeFilter ? { crawlerType: typeFilter } : {}), limit: 100 }).catch(() => ({ jobs: [] })),
  ]);

  const latestByType = crawlersData.registered.reduce<Record<string, CrawlJob | undefined>>(
    (acc, type) => {
      acc[type] = crawlersData.recentJobs.find((j) => j.crawlerType === type);
      return acc;
    },
    {},
  );

  const completed    = jobsData.jobs.filter((j) => j.status === 'completed').length;
  const failed       = jobsData.jobs.filter((j) => j.status === 'failed').length;
  const running      = jobsData.jobs.filter((j) => j.status === 'running').length;
  const totalRecords = jobsData.jobs.reduce((sum, j) => sum + (j.recordsFound ?? 0), 0);
  const hasRunning   = running > 0;

  return (
    <div className="p-8 max-w-7xl">
      <RunningPoller hasRunning={hasRunning} />

      {/* Header */}
      <div className="mb-6 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-navy-900">Crawl Jobs</h1>
            {hasRunning && (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-full px-2.5 py-1">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse inline-block" />
                {running} running
              </span>
            )}
          </div>
          <p className="text-gray-500 mt-1 text-sm">Monitor and trigger data collection crawlers</p>
        </div>
      </div>

      {/* Stats bar */}
      <div className="grid grid-cols-4 gap-4 mb-8">
        <div className="bg-white rounded-lg border shadow-sm p-4">
          <p className="text-xs text-gray-400 uppercase tracking-wide">Total Runs</p>
          <p className="text-2xl font-bold mt-1 text-gray-700">{jobsData.jobs.length}</p>
        </div>
        <div className="bg-white rounded-lg border shadow-sm p-4">
          <p className="text-xs text-gray-400 uppercase tracking-wide">Completed</p>
          <p className="text-2xl font-bold mt-1 text-green-600">{completed}</p>
        </div>
        <div className="bg-white rounded-lg border shadow-sm p-4">
          <p className="text-xs text-gray-400 uppercase tracking-wide">Failed</p>
          <p className={`text-2xl font-bold mt-1 ${failed > 0 ? 'text-red-600' : 'text-gray-400'}`}>{failed}</p>
        </div>
        <div className="bg-white rounded-lg border shadow-sm p-4">
          <p className="text-xs text-gray-400 uppercase tracking-wide">Records Found</p>
          <p className="text-2xl font-bold mt-1 text-navy-900">{totalRecords.toLocaleString()}</p>
        </div>
      </div>

      {/* Crawler cards */}
      <div className="grid grid-cols-2 gap-4 mb-8">
        {crawlersData.registered.map((type) => {
          const latest = latestByType[type];
          const errors = (latest?.errorDetails ?? []) as StructuredCrawlError[];

          return (
            <div key={type} className={`bg-white rounded-lg border shadow-sm overflow-hidden ${borderClass(latest?.status)}`}>
              <div className="p-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-navy-900 text-sm">{type}</p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {CRAWLER_DESCRIPTIONS[type] ?? 'Data collection crawler'}
                    </p>
                  </div>
                  <TriggerButton crawlerType={type} />
                </div>

                <div className="mt-3">
                  <FreshnessChip lastFreshAt={latest?.lastFreshAt} />
                </div>

                <div className="mt-3 grid grid-cols-4 gap-2 text-xs">
                  <div>
                    <p className="text-gray-400 mb-1">Status</p>
                    {latest ? <StatusBadge status={latest.status} /> : <span className="text-gray-300">Never run</span>}
                  </div>
                  <div>
                    <p className="text-gray-400 mb-1">Last run</p>
                    <p className="text-gray-700">{relativeTime(latest?.startedAt)}</p>
                  </div>
                  <div>
                    <p className="text-gray-400 mb-1">Pages</p>
                    <p className="text-gray-700 font-medium">{latest?.pagesCrawled ?? '—'}</p>
                  </div>
                  <div>
                    <p className="text-gray-400 mb-1">Records</p>
                    <p className="text-gray-700 font-medium">{latest?.recordsFound ?? '—'}</p>
                  </div>
                </div>

                {errors.length > 0 && (
                  <div className="mt-3 bg-red-50 border border-red-200 rounded p-2 text-xs text-red-700">
                    <span className="font-medium">{errors.length} error{errors.length > 1 ? 's' : ''}</span>
                    {' — '}
                    <span className="font-mono">{errors[0].code}</span>
                    {errors[0].domain ? ` on ${errors[0].domain}` : ''}
                  </div>
                )}
                {errors.length === 0 && latest?.errorLog && (
                  <div className="mt-3 bg-red-50 border border-red-200 rounded p-2 text-xs text-red-700 font-mono truncate">
                    {latest.errorLog.slice(0, 120)}
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {crawlersData.registered.length === 0 && (
          <div className="col-span-2 bg-white rounded-lg border shadow-sm py-12 text-center text-gray-400 text-sm">
            No crawlers registered. Start the API server to register crawlers.
          </div>
        )}
      </div>

      {/* Job history table */}
      <div className="bg-white rounded-lg border shadow-sm">
        <div className="px-6 py-4 border-b flex items-center justify-between gap-4">
          <div>
            <h2 className="font-semibold text-gray-800">Job History</h2>
            <p className="text-xs text-gray-400 mt-0.5">
              {completed} completed · {failed} failed · {running} running
            </p>
          </div>
          <div className="flex gap-1 flex-wrap justify-end">
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
          <div className="py-12 text-center text-gray-400 text-sm">No job history yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50">
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Crawler</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Status</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Started</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Duration</th>
                <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Pages</th>
                <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Records</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {jobsData.jobs.map((job) => {
                const jobErrors = (job.errorDetails ?? []) as StructuredCrawlError[];
                return (
                  <React.Fragment key={job.id}>
                    <tr className="hover:bg-gray-50">
                      <td className="px-6 py-3 font-medium text-navy-900">{job.crawlerType}</td>
                      <td className="px-6 py-3"><StatusBadge status={job.status} /></td>
                      <td className="px-6 py-3 text-gray-500 text-xs">{formatDateTime(job.startedAt)}</td>
                      <td className={`px-6 py-3 font-mono text-xs ${durationColor(job.durationMs)}`}>
                        {formatDurationMs(job.durationMs)}
                      </td>
                      <td className="px-6 py-3 text-right text-gray-600 text-xs">{job.pagesCrawled ?? '—'}</td>
                      <td className="px-6 py-3 text-right font-medium text-gray-700">{job.recordsFound ?? '—'}</td>
                    </tr>
                    {jobErrors.length > 0 && (
                      <tr className="bg-red-50 border-b border-red-100">
                        <td colSpan={6} className="px-6 py-2 text-xs text-red-700">
                          {jobErrors.slice(0, 3).map((e, i) => (
                            <span key={i} className="mr-4">
                              <span className="font-medium font-mono">{e.code}</span>
                              {e.domain ? ` [${e.domain}]` : ''}
                              {': '}
                              {e.message.slice(0, 80)}
                              {e.message.length > 80 ? '…' : ''}
                            </span>
                          ))}
                          {jobErrors.length > 3 && (
                            <span className="text-red-400">+{jobErrors.length - 3} more</span>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
