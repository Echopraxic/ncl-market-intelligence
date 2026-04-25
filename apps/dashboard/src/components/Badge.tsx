type Variant = 'green' | 'red' | 'yellow' | 'blue' | 'gray' | 'gold';

const VARIANT_CLASSES: Record<Variant, string> = {
  green:  'bg-green-100 text-green-800',
  red:    'bg-red-100 text-red-800',
  yellow: 'bg-yellow-100 text-yellow-800',
  blue:   'bg-blue-100 text-blue-800',
  gray:   'bg-gray-100 text-gray-600',
  gold:   'bg-amber-100 text-amber-800',
};

export function Badge({
  children,
  variant = 'gray',
}: {
  children: React.ReactNode;
  variant?: Variant;
}) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${VARIANT_CLASSES[variant]}`}>
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; variant: Variant }> = {
    completed: { label: 'Completed', variant: 'green' },
    failed:    { label: 'Failed',    variant: 'red'   },
    running:   { label: 'Running',   variant: 'blue'  },
    pending:   { label: 'Pending',   variant: 'yellow'},
  };
  const { label, variant } = map[status] ?? { label: status, variant: 'gray' };
  return <Badge variant={variant}>{label}</Badge>;
}

export function TierBadge({ tier }: { tier: string | null }) {
  const map: Record<string, { label: string; variant: Variant }> = {
    breakthrough: { label: 'Breakthrough', variant: 'green'  },
    accelerating: { label: 'Accelerating', variant: 'blue'   },
    sustained:    { label: 'Sustained',    variant: 'gold'   },
    mature:       { label: 'Mature',       variant: 'gray'   },
    disrupted:    { label: 'Disrupted',    variant: 'red'    },
    watch:        { label: 'Watch',        variant: 'yellow' },
  };
  if (!tier) return <Badge variant="gray">—</Badge>;
  const { label, variant } = map[tier] ?? { label: tier, variant: 'gray' };
  return <Badge variant={variant}>{label}</Badge>;
}

export function PatternBadge({ pattern }: { pattern: string }) {
  const map: Record<string, { label: string; variant: Variant }> = {
    expansion:      { label: 'Expansion',      variant: 'green' },
    rotation:       { label: 'Rotation',       variant: 'blue'  },
    us_brand_entry: { label: 'US Brand Entry', variant: 'gold'  },
  };
  const { label, variant } = map[pattern] ?? { label: pattern, variant: 'gray' };
  return <Badge variant={variant}>{label}</Badge>;
}

export function ReviewStatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; variant: Variant }> = {
    pending:  { label: 'Pending',  variant: 'yellow' },
    approved: { label: 'Approved', variant: 'green'  },
    rejected: { label: 'Rejected', variant: 'red'    },
  };
  const { label, variant } = map[status] ?? { label: status, variant: 'gray' };
  return <Badge variant={variant}>{label}</Badge>;
}

export function SourceBadge({ source }: { source: string }) {
  const map: Record<string, { label: string; variant: Variant }> = {
    google_trends: { label: 'Google Trends', variant: 'blue' },
    amazon_eu:     { label: 'Amazon EU',     variant: 'gold' },
    social:        { label: 'Social',        variant: 'green'},
    retailer:      { label: 'Retailer',      variant: 'gray' },
    trade_data:    { label: 'Trade Data',    variant: 'gray' },
  };
  const { label, variant } = map[source] ?? { label: source, variant: 'gray' };
  return <Badge variant={variant}>{label}</Badge>;
}
