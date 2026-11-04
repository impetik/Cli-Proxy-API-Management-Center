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
