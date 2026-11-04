/**
 * Usage history API (impetik fork; contract in docs/usage-api.md).
 *
 * This is a separate read-only sidecar, not the Management API, so it deliberately does not go
 * through `apiClient` and its `/v8/management` prefix (the AGENTS.md custom HTTP extension
 * exception). It lives on the connection's host at port 8318 and accepts the same management key.
 * A 401 here does not log the user out: it only says this sidecar rejected the key.
 */

import type {
  UsageAggregateRow,
  UsageBucket,
  UsageGroup,
  UsageMeta,
  UsageRequestRow,
  UsageSession,
  UsageTokens,
  UsageTotals,
} from '@/types/usage';
import { normalizeApiBase } from '@/utils/connection';

export const USAGE_API_PORT = '8318';

export interface UsageConnection {
  apiBase: string;
  managementKey: string;
}

/** `status` is the HTTP status, or null when the API could not be reached at all. */
export class UsageApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null
  ) {
    super(message);
    this.name = 'UsageApiError';
  }
}

export const usageApiBase = (apiBase: string): string => {
  const normalized = normalizeApiBase(apiBase);
  if (!normalized) return '';
  try {
    const url = new URL(normalized);
    url.port = USAGE_API_PORT;
    return url.origin;
  } catch {
    return '';
  }
};

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : null;
const num = (value: unknown): number => {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : 0;
};
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const strOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value ? value : null;
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
const rowsOf = (value: unknown): Raw[] => {
  const rows = asRecord(value)?.rows;
  return Array.isArray(rows) ? rows.map(asRecord).filter((row): row is Raw => row !== null) : [];
};

const tokensOf = (row: Raw): UsageTokens => ({
  inputTokens: num(row.input_tokens),
  cacheReadTokens: num(row.cache_read_tokens),
  cacheWriteTokens: num(row.cache_write_tokens),
  outputTokens: num(row.output_tokens),
  reasoningTokens: num(row.reasoning_tokens),
  totalTokens: num(row.total_tokens),
});

const totalsOf = (row: Raw): UsageTotals => ({
  requests: num(row.requests),
  failed: num(row.failed),
  ...tokensOf(row),
  listCostUsd: num(row.list_cost_usd),
  billedCostUsd: num(row.billed_cost_usd),
  avgLatencyMs: num(row.avg_latency_ms),
});

const aggregateRow = (row: Raw): UsageAggregateRow => ({
  t: strOrNull(row.t),
  group: typeof row.group === 'string' ? row.group : null,
  ...totalsOf(row),
});

export const normalizeAggregate = (value: unknown): UsageAggregateRow[] =>
  rowsOf(value).map(aggregateRow);

export const normalizeRequests = (value: unknown): UsageRequestRow[] =>
  rowsOf(value).map((row) => ({
    ts: str(row.ts),
    session: str(row.session),
    key: str(row.key),
    client: str(row.client),
    clientIp: str(row.client_ip),
    agent: str(row.agent),
    userAgent: str(row.user_agent),
    provider: str(row.provider),
    authType: str(row.auth_type),
    model: str(row.model),
    ...tokensOf(row),
    listCostUsd: num(row.list_cost_usd),
    billedCostUsd: num(row.billed_cost_usd),
    latencyMs: num(row.latency_ms),
    failed: row.failed === true || row.failed === 1,
    statusCode: typeof row.status_code === 'number' ? row.status_code : null,
  }));

export const normalizeSessions = (value: unknown): UsageSession[] =>
  rowsOf(value).map((row) => ({
    ...totalsOf(row),
    session: str(row.session),
    firstTs: str(row.first_ts),
    lastTs: str(row.last_ts),
    key: str(row.key),
    client: str(row.client),
    agent: str(row.agent),
    models: strings(row.models),
  }));

export const normalizeMeta = (value: unknown): UsageMeta => {
  const raw = asRecord(value) ?? {};
  return {
    firstTs: strOrNull(raw.first_ts),
    keys: strings(raw.keys),
    models: strings(raw.models),
    clients: strings(raw.clients),
    pricing: { unpricedModels: strings(asRecord(raw.pricing)?.unpriced_models) },
  };
};

type Query = Record<string, string | number | undefined>;

async function getJson(
  conn: UsageConnection,
  path: string,
  query: Query,
  signal?: AbortSignal
): Promise<unknown> {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(name, String(value));
  }
  const qs = params.toString();
  let response: Response;
  try {
    response = await fetch(`${usageApiBase(conn.apiBase)}${path}${qs ? `?${qs}` : ''}`, {
      headers: { Authorization: `Bearer ${conn.managementKey}` },
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new UsageApiError(error instanceof Error ? error.message : String(error), null);
  }
  if (!response.ok) throw new UsageApiError(`HTTP ${response.status}`, response.status);
  return response.json();
}

export interface UsageAggregateQuery {
  from: string;
  to: string;
  group: UsageGroup;
  bucket?: UsageBucket;
}

export interface UsageRequestsQuery {
  from: string;
  to: string;
  limit?: number;
  key?: string;
  model?: string;
  client?: string;
  session?: string;
}

export interface UsageSessionsQuery {
  from: string;
  to: string;
  limit?: number;
  /** Server-side order over every session in the range (default recent). */
  sort?: 'recent' | 'cost';
}

export const usageApi = {
  aggregate: async (conn: UsageConnection, query: UsageAggregateQuery, signal?: AbortSignal) =>
    normalizeAggregate(await getJson(conn, '/usage/aggregate', { ...query }, signal)),
  requests: async (conn: UsageConnection, query: UsageRequestsQuery, signal?: AbortSignal) =>
    normalizeRequests(await getJson(conn, '/usage/requests', { ...query }, signal)),
  sessions: async (conn: UsageConnection, query: UsageSessionsQuery, signal?: AbortSignal) =>
    normalizeSessions(await getJson(conn, '/usage/sessions', { ...query }, signal)),
  meta: async (conn: UsageConnection, signal?: AbortSignal) =>
    normalizeMeta(await getJson(conn, '/usage/meta', {}, signal)),
};
