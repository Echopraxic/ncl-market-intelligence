import { getBrands } from '@/lib/api';
import { Badge } from '@/components/Badge';
import { StatCard } from '@/components/StatCard';
import Link from 'next/link';

type SearchParams = Promise<{ euPresence?: string; offset?: string }>;

export default async function BrandsPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const offset = parseInt(params.offset ?? '0', 10);
  const euFilter = params.euPresence;

  const data = await getBrands({
    ...(euFilter === 'true' ? { euPresence: true } : euFilter === 'false' ? { euPresence: false } : {}),
    limit: 24,
    offset,
  }).catch(() => ({ brands: [], limit: 24, offset: 0 }));

  const allData = await getBrands({ limit: 200 }).catch(() => ({ brands: [], limit: 200, offset: 0 }));
  const euCount = allData.brands.filter((b) => b.euPresence).length;

  const segments: Record<string, string> = {
    toys: 'Toys', cpg: 'CPG', wellness: 'Wellness', 'home-goods': 'Home Goods',
  };

  function inferSegment(categories: string[] | null): string {
    if (!categories) return 'Other';
    const lc = categories.map((c) => c.toLowerCase()).join(' ');
    if (lc.includes('toy') || lc.includes('game') || lc.includes('stem')) return 'Toys';
    if (lc.includes('snack') || lc.includes('food') || lc.includes('chocolate')) return 'CPG';
    if (lc.includes('supplement') || lc.includes('wellness') || lc.includes('vitamin')) return 'Wellness';
    if (lc.includes('home') || lc.includes('bedding') || lc.includes('cleaning')) return 'Home Goods';
    return 'Other';
  }

  return (
    <div className="p-8 max-w-6xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-navy-900">Brands</h1>
        <p className="text-gray-500 mt-1 text-sm">US brands seeded for EU expansion analysis</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <StatCard label="Total brands" value={allData.brands.length} />
        <StatCard label="EU presence" value={euCount} sub={`${Math.round((euCount / Math.max(allData.brands.length, 1)) * 100)}% of brands`} />
        <StatCard label="No EU presence" value={allData.brands.length - euCount} sub="expansion candidates" />
      </div>

      {/* Filters */}
      <form method="GET" className="flex items-center gap-3 mb-6">
        <label className="text-sm text-gray-600 font-medium">EU Presence:</label>
        {[
          { value: '', label: 'All' },
          { value: 'false', label: 'No (candidates)' },
          { value: 'true', label: 'Yes (established)' },
        ].map(({ value, label }) => (
          <a
            key={value}
            href={`/brands${value ? `?euPresence=${value}` : ''}`}
            className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
              euFilter === value || (!euFilter && value === '')
                ? 'bg-navy-900 text-white border-navy-900'
                : 'bg-white text-gray-600 border-gray-300 hover:border-navy-900'
            }`}
          >
            {label}
          </a>
        ))}
      </form>

      {/* Brand grid */}
      {data.brands.length === 0 ? (
        <div className="bg-white rounded-lg border shadow-sm py-16 text-center">
          <p className="text-gray-400 text-sm">No brands yet — run the Shopify Brand crawler to seed the catalog.</p>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-4">
          {data.brands.map((brand) => (
            <div key={brand.id} className="bg-white rounded-lg border shadow-sm p-5 flex flex-col gap-3">
              {/* Header */}
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-semibold text-navy-900 text-sm">{brand.name}</p>
                  <p className="text-xs text-gray-400">{brand.country}</p>
                </div>
                <Badge variant={brand.euPresence ? 'green' : 'gray'}>
                  {brand.euPresence ? 'EU ✓' : 'No EU'}
                </Badge>
              </div>

              {/* Segment */}
              <Badge variant="gold">{inferSegment(brand.categories)}</Badge>

              {/* Categories */}
              {brand.categories && brand.categories.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {brand.categories.slice(0, 4).map((cat) => (
                    <span key={cat} className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">
                      {cat}
                    </span>
                  ))}
                  {brand.categories.length > 4 && (
                    <span className="text-xs text-gray-400">+{brand.categories.length - 4} more</span>
                  )}
                </div>
              )}

              {/* Website link */}
              {brand.websiteUrl && (
                <a
                  href={brand.websiteUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-gold-500 hover:underline truncate"
                >
                  {brand.websiteUrl.replace(/^https?:\/\//, '')}
                </a>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Pagination */}
      {data.brands.length === 24 && (
        <div className="flex justify-end mt-6 gap-2">
          {offset > 0 && (
            <a
              href={`/brands?${euFilter ? `euPresence=${euFilter}&` : ''}offset=${offset - 24}`}
              className="px-4 py-2 text-sm bg-white border rounded hover:bg-gray-50"
            >
              ← Previous
            </a>
          )}
          <a
            href={`/brands?${euFilter ? `euPresence=${euFilter}&` : ''}offset=${offset + 24}`}
            className="px-4 py-2 text-sm bg-white border rounded hover:bg-gray-50"
          >
            Next →
          </a>
        </div>
      )}
    </div>
  );
}
