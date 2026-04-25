import { getTradeShows } from '@/lib/api';
import { Badge } from '@/components/Badge';
import { StatCard } from '@/components/StatCard';
import { formatDate } from '@/lib/utils';

type SearchParams = Promise<{ upcoming?: string }>;

const COUNTRY_NAMES: Record<string, string> = {
  US: 'United States', FR: 'France', CN: 'China', DE: 'Germany',
  GB: 'United Kingdom', NL: 'Netherlands',
};

export default async function TradeShowsPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const showUpcoming = params.upcoming !== 'false';

  const data = await getTradeShows({ upcoming: showUpcoming, limit: 20 })
    .catch(() => ({ shows: [] }));

  const totalExhibitors = data.shows.reduce((sum, s) => sum + (s.exhibitorCount ?? 0), 0);

  return (
    <div className="p-8 max-w-6xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-navy-900">Trade Shows</h1>
        <p className="text-gray-500 mt-1 text-sm">
          Upcoming trade shows and exhibitor directories for brand discovery
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <StatCard label="Shows tracked" value={data.shows.length} />
        <StatCard label="Total exhibitors" value={totalExhibitors} sub="across all shows" />
        <StatCard label="Next show" value={data.shows[0]?.name?.split(' ')[0] ?? '—'} sub={data.shows[0] ? formatDate(data.shows[0].startDate) : ''} />
      </div>

      {/* Toggle */}
      <div className="flex gap-2 mb-6">
        <a
          href="/trade-shows"
          className={`px-4 py-2 rounded-full text-xs font-medium border transition-colors ${
            showUpcoming
              ? 'bg-navy-900 text-white border-navy-900'
              : 'bg-white text-gray-600 border-gray-300 hover:border-navy-900'
          }`}
        >
          Upcoming
        </a>
        <a
          href="/trade-shows?upcoming=false"
          className={`px-4 py-2 rounded-full text-xs font-medium border transition-colors ${
            !showUpcoming
              ? 'bg-navy-900 text-white border-navy-900'
              : 'bg-white text-gray-600 border-gray-300 hover:border-navy-900'
          }`}
        >
          All shows
        </a>
      </div>

      {/* Show cards */}
      {data.shows.length === 0 ? (
        <div className="bg-white rounded-lg border shadow-sm py-16 text-center">
          <p className="text-gray-400 text-sm">
            No trade shows yet. Run the Trade Show crawler to seed show metadata.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-5">
          {data.shows.map((show) => {
            const startDate = show.startDate ? new Date(show.startDate) : null;
            const endDate = show.endDate ? new Date(show.endDate) : null;
            const isUpcoming = startDate ? startDate > new Date() : false;
            const daysUntil = startDate
              ? Math.ceil((startDate.getTime() - Date.now()) / 86_400_000)
              : null;

            return (
              <div key={show.id} className="bg-white rounded-lg border shadow-sm p-6 flex flex-col gap-4">
                {/* Header */}
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-navy-900">{show.name}</h3>
                    <p className="text-xs text-gray-500 mt-0.5">{show.location}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1.5 shrink-0">
                    <Badge variant={isUpcoming ? 'green' : 'gray'}>
                      {isUpcoming ? 'Upcoming' : 'Past'}
                    </Badge>
                    {show.countryCode && (
                      <span className="text-xs text-gray-400">{show.countryCode}</span>
                    )}
                  </div>
                </div>

                {/* Dates */}
                <div className="flex items-center gap-4 text-sm">
                  <div>
                    <p className="text-xs text-gray-400">Dates</p>
                    <p className="font-medium text-gray-700">
                      {startDate && endDate
                        ? `${formatDate(show.startDate)} – ${formatDate(show.endDate)}`
                        : '—'}
                    </p>
                  </div>
                  {daysUntil !== null && isUpcoming && (
                    <div>
                      <p className="text-xs text-gray-400">In</p>
                      <p className="font-medium text-gold-500">{daysUntil}d</p>
                    </div>
                  )}
                  <div>
                    <p className="text-xs text-gray-400">Exhibitors</p>
                    <p className="font-medium text-gray-700">{show.exhibitorCount ?? 0}</p>
                  </div>
                </div>

                {/* Categories */}
                {show.categories && show.categories.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {show.categories.slice(0, 5).map((cat) => (
                      <span key={cat} className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">
                        {cat}
                      </span>
                    ))}
                    {show.categories.length > 5 && (
                      <span className="text-xs text-gray-400">+{show.categories.length - 5}</span>
                    )}
                  </div>
                )}

                {/* Website */}
                {show.websiteUrl && (
                  <a
                    href={show.websiteUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-gold-500 hover:underline"
                  >
                    {show.websiteUrl.replace(/^https?:\/\//, '')} →
                  </a>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
