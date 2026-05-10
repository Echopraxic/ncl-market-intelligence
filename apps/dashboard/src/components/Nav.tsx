import Link from 'next/link';

const LINKS = [
  { href: '/',                  label: 'Overview',          icon: '◎' },
  { href: '/brands',            label: 'Brands',            icon: '⬡' },
  { href: '/signals',           label: 'Market Signals',    icon: '↗' },
  { href: '/trends',            label: 'Trends',            icon: '◈' },
  { href: '/gaps',              label: 'Gap Scores',        icon: '◐' },
  { href: '/retailer-insights', label: 'Retailer Insights', icon: '⊡' },
  { href: '/trade-analytics',   label: 'Trade Analytics',   icon: '⟁' },
  { href: '/human-review',      label: 'Human Review',      icon: '✓' },
  { href: '/trade-shows',       label: 'Trade Shows',       icon: '◩' },
  { href: '/opportunities',     label: 'Opportunities',     icon: '★' },
  { href: '/insights-feed',     label: 'Insights',          icon: '◉' },
  { href: '/crawl-jobs',        label: 'Crawl Jobs',        icon: '⟳' },
  // Lead Generation
  { href: '/leads',             label: 'Leads',             icon: '⊕' },
  { href: '/outreach-queue',    label: 'Outreach Queue',    icon: '✉' },
  { href: '/lead-pipeline',     label: 'Lead Pipeline',     icon: '▷' },
  // Distributor Intelligence
  { href: '/distributors',          label: 'Distributors',     icon: '⊡' },
  { href: '/buyer-intent',          label: 'Buyer Intent',     icon: '⤷' },
  { href: '/distributor-matches',   label: 'Matches',          icon: '⇄' },
  // Reports
  { href: '/reports',           label: 'Reports',           icon: '◧' },
];

export function Nav() {
  return (
    <aside className="fixed inset-y-0 left-0 w-56 bg-navy-900 flex flex-col z-10">
      {/* Logo */}
      <div className="px-5 py-5 border-b border-navy-800">
        <p className="text-white font-bold text-sm tracking-wide">NCL</p>
        <p className="text-gold-500 text-xs font-medium mt-0.5">Market Intelligence</p>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
        {LINKS.map(({ href, label, icon }) => (
          <Link
            key={href}
            href={href}
            className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-gray-300 hover:bg-navy-800 hover:text-white transition-colors"
          >
            <span className="text-gold-500 text-xs w-4 text-center">{icon}</span>
            {label}
          </Link>
        ))}
      </nav>

      {/* Footer */}
      <div className="px-5 py-4 border-t border-navy-800">
        <p className="text-gray-500 text-xs">Phase 4 · Lead Generation</p>
      </div>
    </aside>
  );
}
