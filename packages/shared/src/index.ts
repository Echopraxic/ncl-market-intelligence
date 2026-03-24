export type CountryCode = 'DE' | 'FR' | 'NL' | 'GB' | 'ES' | 'IT' | 'BE' | 'PL' | 'SE' | 'DK';
export type SignalSource = 'google_trends' | 'amazon_eu' | 'social' | 'retailer' | 'trade_data';
export type SignalType = 'demand' | 'supply' | 'trend' | 'gap';
export type ActivityType = 'new_listing' | 'category_expansion' | 'seasonal_rotation';
export type InsightType = 'weekly_report' | 'opportunity_alert' | 'trade_show_playbook' | 'market_brief';
export type InsightStatus = 'draft' | 'published' | 'sent';
export type CampaignType = 'email' | 'linkedin' | 'phone';
export type CampaignStatus = 'queued' | 'sent' | 'opened' | 'replied';
export type CrawlStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface ApiError {
  error: string;
  details?: unknown;
}
