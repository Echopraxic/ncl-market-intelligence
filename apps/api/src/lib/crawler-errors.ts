export enum CrawlErrorCode {
  TIMEOUT = 'TIMEOUT',
  BOT_BLOCKED = 'BOT_BLOCKED',
  RATE_LIMITED = 'RATE_LIMITED',
  SELECTOR_MISMATCH = 'SELECTOR_MISMATCH',
  AUTH_REQUIRED = 'AUTH_REQUIRED',
  PAGE_NOT_FOUND = 'PAGE_NOT_FOUND',
  NETWORK_ERROR = 'NETWORK_ERROR',
  PARSE_ERROR = 'PARSE_ERROR',
  STALE_DATA = 'STALE_DATA',
  DATA_QUALITY = 'DATA_QUALITY',
  UNKNOWN = 'UNKNOWN',
}

export interface StructuredCrawlError {
  code: CrawlErrorCode;
  domain?: string;
  category?: string;
  message: string;
  retryable: boolean;
  timestamp: string;
}

export function classifyError(message: string): CrawlErrorCode {
  const m = message.toLowerCase();
  if (m.includes('timeout')) return CrawlErrorCode.TIMEOUT;
  if (m.includes('429') || m.includes('rate limit')) return CrawlErrorCode.RATE_LIMITED;
  if (m.includes('bot') || m.includes('captcha') || m.includes('robot')) return CrawlErrorCode.BOT_BLOCKED;
  if (m.includes('signin') || m.includes('auth')) return CrawlErrorCode.AUTH_REQUIRED;
  if (m.includes('404') || m.includes('not found')) return CrawlErrorCode.PAGE_NOT_FOUND;
  if (m.includes('selector') || m.includes('parse')) return CrawlErrorCode.SELECTOR_MISMATCH;
  if (m.includes('fetch') || m.includes('network') || m.includes('econnrefused')) return CrawlErrorCode.NETWORK_ERROR;
  return CrawlErrorCode.UNKNOWN;
}

const RETRYABLE = new Set([
  CrawlErrorCode.TIMEOUT,
  CrawlErrorCode.RATE_LIMITED,
  CrawlErrorCode.NETWORK_ERROR,
]);

export function isRetryable(code: CrawlErrorCode): boolean {
  return RETRYABLE.has(code);
}
