import { getBuyerIntent } from '@/lib/api';
import { TriggerButton } from '@/components/TriggerButton';
import { Badge } from '@/components/Badge';

export const dynamic = 'force-dynamic';

const CATEGORY_LABELS: Record<string, string> = {
  food_beverage: 'Food & Beverage',
  supplements: 'Supplements',
  cosmetics_personal_care: 'Cosmetics & Personal Care',
  home_goods: 'Home Goods',
  toys_games: 'Toys & Games',
};

export default async function BuyerIntentPage({
  searchParams,
}: {
  searchParams: { category?: string; minStrength?: string };
}) {
  const { category, minStrength } = searchParams;
  const { intent, count } = await getBuyerIntent({
    category,
    minStrength: minStrength ? Number(minStrength) : 0.3,
    limit: 200,
  });

  // Group by category
  const byCategory = intent.reduce<Record<string, typeof intent>>((acc, row) => {
    acc[row.category] ??= [];
    acc[row.category].push(row);
    return acc;
  }, {});

  const activeCategories = Object.keys(byCategory).sort();

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">Active Buyer Intent</h1>
          <p className="text-gray-400 text-sm mt-1">{count} signals across {activeCategories.length} categories</p>
        </div>
        <TriggerButton agentType="buyer-intent" label="Refresh Intent" />
      </div>

      {/* Filters */}
      <form className="flex gap-3">
        <select name="category" defaultValue={category ?? ''} className="bg-navy-800 border border-navy-700 text-white text-sm rounded px-3 py-1.5">
          <option value="">All Categories</option>
          {activeCategories.map(c => (
            <option key={c} value={c}>{CATEGORY_LABELS[c] ?? c}</option>
          ))}
        </select>
        <select name="minStrength" defaultValue={minStrength ?? '0.3'} className="bg-navy-800 border border-navy-700 text-white text-sm rounded px-3 py-1.5">
          <option value="0">All Intent</option>
          <option value="0.3">Baseline (0.3+)</option>
          <option value="0.5">Active (0.5+)</option>
          <option value="0.7">Strong (0.7+)</option>
          <option value="0.9">LinkedIn-confirmed (0.9+)</option>
        </select>
        <button type="submit" className="bg-gold-500 text-navy-900 text-sm font-medium px-4 py-1.5 rounded hover:bg-gold-400">
          Filter
        </button>
      </form>

      {/* Category cards */}
      <div className="space-y-6">
        {activeCategories.map(cat => {
          const rows = byCategory[cat];
          const countries = [...new Set(rows.map(r => r.countryCode))];
          return (
            <div key={cat} className="bg-navy-800 rounded-lg p-5">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-white font-semibold">{CATEGORY_LABELS[cat] ?? cat}</h2>
                  <p className="text-gray-400 text-sm mt-0.5">{rows.length} distributors sourcing · {countries.join(', ')}</p>
                </div>
                <Badge variant="gold">{rows.length} active</Badge>
              </div>
              <div className="space-y-2">
                {rows.slice(0, 10).map(row => (
                  <div key={row.id} className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-3">
                      <span className="text-gray-300 font-medium">{row.distributorName}</span>
                      <span className="text-gray-500 text-xs">{row.countryCode}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-gray-500">{row.source}</span>
                      <div className="w-24 bg-navy-700 rounded-full h-1.5">
                        <div
                          className={`h-1.5 rounded-full ${(row.intentStrength ?? 0) >= 0.7 ? 'bg-green-400' : (row.intentStrength ?? 0) >= 0.5 ? 'bg-yellow-400' : 'bg-gray-500'}`}
                          style={{ width: `${Math.round((row.intentStrength ?? 0) * 100)}%` }}
                        />
                      </div>
                      <span className={`text-xs font-mono ${(row.intentStrength ?? 0) >= 0.7 ? 'text-green-400' : (row.intentStrength ?? 0) >= 0.5 ? 'text-yellow-400' : 'text-gray-400'}`}>
                        {((row.intentStrength ?? 0) * 100).toFixed(0)}%
                      </span>
                    </div>
                  </div>
                ))}
                {rows.length > 10 && (
                  <p className="text-gray-500 text-xs mt-2">+{rows.length - 10} more</p>
                )}
              </div>
            </div>
          );
        })}
        {activeCategories.length === 0 && (
          <p className="text-gray-500 text-sm text-center py-8">No intent signals found. Run Buyer Intent analysis to populate.</p>
        )}
      </div>
    </div>
  );
}
