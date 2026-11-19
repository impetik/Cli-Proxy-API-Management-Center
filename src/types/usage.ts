/** Usage history from the read-only usage API (docs/usage-api.md), normalised to camelCase. */

export type UsageDimension = 'key' | 'model' | 'provider' | 'client' | 'agent';
export type UsageGroup = UsageDimension | 'none';
export type UsageBucket = 'hour' | 'day';

export interface UsageTokens {
  /** Uncached input. */
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Includes reasoning. */
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface UsageTotals extends UsageTokens {
  requests: number;
  failed: number;
  /** What the tokens would cost at public API prices; not money spent for subscriptions. */
  listCostUsd: number;
  /** Money actually spent (API-key providers only). */
  billedCostUsd: number;
  avgLatencyMs: number;
}

export interface UsageAggregateRow extends UsageTotals {
  /** Bucket start, present only when a bucket was requested. */
  t: string | null;
  /** Group value, absent for `group=none`. */
  group: string | null;
}

export interface UsageRequestRow extends UsageTokens {
  ts: string;
  /** Client session id; empty when the client sent none. */
  session: string;
  key: string;
  client: string;
  clientIp: string;
  agent: string;
  userAgent: string;
  provider: string;
  authType: string;
  model: string;
  listCostUsd: number;
  billedCostUsd: number;
  latencyMs: number;
  failed: boolean;
  statusCode: number | null;
}

export interface UsageMeta {
  firstTs: string | null;
  keys: string[];
  models: string[];
  clients: string[];
  pricing: { unpricedModels: string[] };
}

/** One client session (for Claude Code, its session id) with its aggregate totals. */
export interface UsageSession extends UsageTotals {
  session: string;
  firstTs: string;
  lastTs: string;
  key: string;
  client: string;
  agent: string;
  /** By cost, highest first. */
  models: string[];
}

export type QuotaWindow = '5h' | 'day';
export const QUOTA_WINDOWS: readonly QuotaWindow[] = ['5h', 'day'];

/** One key's rolling-window spend against its limits (USD at list price). */
export interface UsageKeyQuota {
  /** Only windows with a positive limit; the server does not enforce the others. */
  limits: Partial<Record<QuotaWindow, number>>;
  used: Record<QuotaWindow, number>;
  blockedUntil: string | null;
  blockedWindow: QuotaWindow | null;
}

export interface UsageQuotas {
  /** When the server's checker last ran; null if never. */
  updated: string | null;
  keys: Record<string, UsageKeyQuota>;
}
