// ---------------------------------------------------------------------------
// Typed API client for the NCL MIE backend
// All calls run server-side (no NEXT_PUBLIC_ exposure of the API key).
// ---------------------------------------------------------------------------

const API_BASE = process.env.API_URL ?? 'http://localhost:3001';
const API_KEY  = process.env.API_SECRET_KEY ?? '';

async function apiFetch<T>(
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
  revalidate = 60,
): Promise<T> {
  const url = new URL(path, API_BASE);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url.toString(), {
    headers: { 'x-api-key': API_KEY },
    next: { revalidate },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Types (mirrored from Drizzle schema)
// ---------------------------------------------------------------------------

export type Brand = {
  id: string;
  name: string;
  websiteUrl: string | null;
  shopifyStoreUrl: string | null;
  categories: string[] | null;
  country: string;
  euPresence: boolean | null;
  annualRevenueEstimate: number | null;
  employeeCount: number | null;
  createdAt: string;
  updatedAt: string;
};

export type Signal = {
  id: string;
  source: 'google_trends' | 'amazon_eu' | 'social' | 'retailer' | 'trade_data';
  countryCode: string;
  category: string;
  signalType: 'demand' | 'supply' | 'trend' | 'gap';
  signalValue: number;
  rawData: Record<string, unknown> | null;
  capturedAt: string;
};

export type CrawlJob = {
  id: string;
  crawlerType: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startedAt: string | null;
  completedAt: string | null;
  recordsFound: number | null;
  errorLog: string | null;
};

export type TradeShow = {
  id: string;
  name: string;
  location: string | null;
  countryCode: string | null;
  startDate: string | null;
  endDate: string | null;
  categories: string[] | null;
  websiteUrl: string | null;
  exhibitorCount: number;
};

export type Exhibitor = {
  id: string;
  tradeShowId: string;
  brandName: string;
  brandWebsite: string | null;
  categories: string[] | null;
  boothInfo: string | null;
};

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export async function getBrands(params?: {
  euPresence?: boolean;
  limit?: number;
  offset?: number;
}): Promise<{ brands: Brand[]; limit: number; offset: number }> {
  return apiFetch('/api/brands', params as Record<string, string | number | boolean | undefined>);
}

export async function getSignals(params?: {
  countryCode?: string;
  category?: string;
  source?: string;
  since?: string;
  limit?: number;
}): Promise<{ signals: Signal[]; limit: number }> {
  return apiFetch('/api/signals', params as Record<string, string | number | boolean | undefined>);
}

export async function getCrawlJobs(params?: {
  crawlerType?: string;
  limit?: number;
}): Promise<{ jobs: CrawlJob[] }> {
  return apiFetch('/api/crawl-jobs', params as Record<string, string | number | boolean | undefined>, 0);
}

export async function getCrawlers(): Promise<{
  registered: string[];
  recentJobs: CrawlJob[];
}> {
  return apiFetch('/api/crawlers', undefined, 0);
}

export async function getTradeShows(params?: {
  upcoming?: boolean;
  limit?: number;
}): Promise<{ shows: TradeShow[] }> {
  return apiFetch('/api/trade-shows', params as Record<string, string | number | boolean | undefined>);
}

// ---------------------------------------------------------------------------
// Phase 2 types
// ---------------------------------------------------------------------------

export type OpportunityTier =
  | 'breakthrough'
  | 'accelerating'
  | 'sustained'
  | 'mature'
  | 'disrupted'
  | 'watch';

export type Trend = {
  id: string;
  category: string;
  countryCode: string;
  growthRate: number;
  opportunityTier: OpportunityTier | null;
  confidence: number;
  isAccelerating: boolean;
  volatilityIndex: number | null;
  status: string;
  periodStart: string;
  periodEnd: string;
  detectionMethods: string[] | null;
  createdAt: string;
};

export type GapScore = {
  id: string;
  category: string;
  countryCode: string;
  gapScore: number;
  demandSignal: number;
  importReliance: number;
  localBrandDensity: number;
  demandPercentile: number;
  importPercentile: number;
  densityPercentile: number;
  generatedAt: string;
};

export type RetailerInsight = {
  id: string;
  category: string;
  countryCode: string;
  patternType: 'expansion' | 'rotation' | 'us_brand_entry';
  retailerCount: number;
  confidence: number;
  aiSynthesis: string | null;
  ruleDetails: {
    retailerNames: string[];
    windowDays: number;
    activityCount: number;
    dateRange: { first: string; last: string };
  };
  detectedAt: string;
};

export type TradeAnalytic = {
  id: string;
  nclCategory: string;
  reporterCountry: string;
  partnerCountry: string;
  hsChapter: string;
  asOfYear: number;
  yoyGrowthPct: number | null;
  cagr3yr: number | null;
  accelerationScore: number | null;
  isAccelerating: boolean;
  breakpointDetected: boolean;
  breakpointType: string | null;
  usMarketSharePct: number | null;
  shareChangePct: number | null;
  shareTrend: string | null;
  saturationRiskScore: number | null;
  oversupplySaturationFlag: boolean;
};

export type HumanReviewItem = {
  id: string;
  type: string;
  priority: number;
  data: Record<string, unknown>;
  validationResult: Record<string, unknown> | null;
  reviewPrompt: string | null;
  status: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
};

// ---------------------------------------------------------------------------
// Phase 2 API functions
// ---------------------------------------------------------------------------

export async function getTrends(params?: {
  countryCode?: string;
  category?: string;
  tier?: OpportunityTier;
  minGrowthRate?: number;
  status?: string;
  limit?: number;
}): Promise<{ trends: Trend[]; limit: number }> {
  return apiFetch('/api/trends', params as Record<string, string | number | boolean | undefined>);
}

export async function getGapScores(params?: {
  countryCode?: string;
  category?: string;
  minGapScore?: number;
  limit?: number;
}): Promise<{ gaps: GapScore[]; limit: number }> {
  return apiFetch('/api/gaps', params as Record<string, string | number | boolean | undefined>);
}

export async function getRetailerInsights(params?: {
  countryCode?: string;
  category?: string;
  patternType?: string;
  limit?: number;
}): Promise<{ insights: RetailerInsight[]; limit: number }> {
  return apiFetch('/api/retailer-insights', params as Record<string, string | number | boolean | undefined>);
}

export async function getTradeAnalytics(params?: {
  category?: string;
  country?: string;
  isAccelerating?: boolean;
  limit?: number;
}): Promise<{ analytics: TradeAnalytic[]; count: number; limit: number }> {
  return apiFetch('/api/trade-analytics', params as Record<string, string | number | boolean | undefined>);
}

export async function getHumanReview(params?: {
  type?: string;
  status?: string;
  limit?: number;
}): Promise<{ items: HumanReviewItem[]; count: number; limit: number }> {
  return apiFetch('/api/human-review', params as Record<string, string | number | boolean | undefined>, 0);
}

// ---------------------------------------------------------------------------
// Phase 3 types
// ---------------------------------------------------------------------------

export type OpportunityScore = {
  id: string;
  brandId: string | null;
  category: string;
  countryCode: string;
  compositeScore: number;
  categoryOpportunityScore: number;
  brandFitScore: number;
  niSuitabilityPreScore: number;
  scoringFactors: Record<string, unknown> | null;
  generatedAt: string;
};

export type BrandScore = {
  id: string;
  brandId: string | null;
  brandName: string;
  euPresence: boolean | null;
  annualRevenueEstimate: number | null;
  shopifyStoreUrl: string | null;
  category: string;
  countryCode: string;
  compositeScore: number;
  categoryOpportunityScore: number;
  brandFitScore: number;
  niSuitabilityPreScore: number;
  scoringFactors: Record<string, unknown> | null;
  generatedAt: string;
};

export type Insight = {
  id: string;
  type: 'opportunity_alert' | 'market_brief' | 'trade_show_playbook' | 'weekly_report';
  title: string;
  body: string;
  status: 'draft' | 'published' | 'sent';
  createdAt: string;
};

export type TradeShowPlaybook = {
  id: string;
  tradeShowId: string;
  showName: string | null;
  showLocation: string | null;
  showStartDate: string | null;
  showEndDate: string | null;
  matchedCategories: string[];
  relevantCorridors: Array<{ category: string; countryCode: string; compositeScore: number }>;
  exhibitorMatches: Array<{
    brandName: string;
    brandId: string | null;
    compositeScore: number | null;
    brandFitScore: number | null;
    niScore: number | null;
    annualRevenue: number | null;
    euPresence: boolean | null;
    hasShopify: boolean;
    pitchAngle: string;
  }>;
  distributorCoverage: Array<{
    category: string;
    countryCode: string;
    distributorCount: number;
    distributorNames: string[];
    coverageGap: boolean;
  }>;
  topPipelineBrands: Array<{ brandName: string; brandId: string; compositeScore: number; category: string; countryCode: string }>;
  totalExhibitors: number;
  matchedExhibitors: number;
  narrative: string;
  status: string;
  generatedAt: string;
};

// ---------------------------------------------------------------------------
// Phase 3 API functions
// ---------------------------------------------------------------------------

export async function getOpportunityScores(params?: {
  countryCode?: string;
  category?: string;
  minComposite?: number;
  limit?: number;
}): Promise<{ scores: OpportunityScore[]; count: number; limit: number }> {
  return apiFetch('/api/opportunity-scores', params as Record<string, string | number | boolean | undefined>);
}

export async function getBrandScores(params?: {
  countryCode?: string;
  category?: string;
  minComposite?: number;
  limit?: number;
}): Promise<{ scores: BrandScore[]; count: number; limit: number }> {
  return apiFetch('/api/brand-scores', params as Record<string, string | number | boolean | undefined>);
}

export async function getInsights(params?: {
  type?: string;
  status?: string;
  limit?: number;
}): Promise<{ insights: Insight[]; count: number; limit: number }> {
  return apiFetch('/api/insights', params as Record<string, string | number | boolean | undefined>);
}

export async function getTradeShowPlaybooks(params?: {
  status?: string;
  limit?: number;
}): Promise<{ playbooks: TradeShowPlaybook[]; count: number; limit: number }> {
  return apiFetch('/api/trade-show-playbooks', params as Record<string, string | number | boolean | undefined>);
}

// ---------------------------------------------------------------------------
// Lead Generation types
// ---------------------------------------------------------------------------

export type LeadStatus = 'new' | 'reviewed' | 'approved' | 'contacted' | 'replied' | 'qualified' | 'won' | 'lost' | 'invalid';
export type PipelineStage = 'prospecting' | 'engaged' | 'qualified' | 'proposal' | 'negotiation' | 'closed_won' | 'closed_lost';

export type Lead = {
  id: string;
  companyName: string;
  contactName: string | null;
  email: string | null;
  linkedinUrl: string | null;
  websiteUrl: string | null;
  leadType: string;
  discoverySource: string;
  brandId: string | null;
  leadQualityScore: number;
  opportunityScore: number | null;
  gapScore: number | null;
  trendTier: string | null;
  bestCategory: string | null;
  bestCountryCode: string | null;
  pitchAngle: string | null;
  pitchSummary: string | null;
  categories: string[] | null;
  euPresence: boolean | null;
  employeeGrowthSignal: string | null;
  status: LeadStatus;
  assignedTo: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LeadCampaign = {
  id: string;
  leadId: string;
  campaignType: string;
  subject: string;
  body: string;
  status: string;
  resendMessageId: string | null;
  sentAt: string | null;
  openedAt: string | null;
  clickedAt: string | null;
  repliedAt: string | null;
  bouncedAt: string | null;
  bounceReason: string | null;
  replySentiment: string | null;
  createdAt: string;
};

export type LeadPipelineRow = {
  id: string;
  leadId: string;
  stage: PipelineStage;
  estimatedValue: number | null;
  probabilityPercent: number | null;
  expectedCloseDate: string | null;
  movedAt: string;
};

export type PipelineSummary = {
  stages: Array<{ stage: PipelineStage; count: number; totalValue: number }>;
  totalLeads: number;
  totalEstimatedValue: number;
};

// ---------------------------------------------------------------------------
// Lead Generation API functions
// ---------------------------------------------------------------------------

export async function getLeads(params?: {
  status?: LeadStatus;
  source?: string;
  minScore?: number;
  category?: string;
  limit?: number;
}): Promise<{ leads: Lead[]; count: number; limit: number }> {
  return apiFetch('/api/leads', params as Record<string, string | number | boolean | undefined>, 0);
}

export async function getLead(id: string): Promise<{ lead: Lead; campaigns: LeadCampaign[]; pipeline: LeadPipelineRow | null }> {
  return apiFetch(`/api/leads/${id}`, undefined, 0);
}

export async function getCampaigns(params?: {
  leadId?: string;
  status?: string;
  limit?: number;
}): Promise<{ campaigns: LeadCampaign[]; count: number; limit: number }> {
  return apiFetch('/api/campaigns', params as Record<string, string | number | boolean | undefined>, 0);
}

export async function getLeadPipeline(): Promise<PipelineSummary> {
  return apiFetch('/api/lead-pipeline', undefined, 0);
}
