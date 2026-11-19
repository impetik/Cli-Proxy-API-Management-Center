/** Pure range, aggregation and formatting logic for the Usage page. */

import type {
  QuotaWindow,
  UsageAggregateRow,
  UsageBucket,
  UsageDimension,
  UsageMeta,
  UsageQuotas,
  UsageTotals,
} from '@/types/usage';
import { QUOTA_WINDOWS } from '@/types/usage';
import { formatCompactNumber } from '@/utils/format';

export type RangePreset = '24h' | '7d' | '30d' | 'custom';
export const RANGE_PRESETS: readonly RangePreset[] = ['24h', '7d', '30d', 'custom'];
export const DIMENSIONS: readonly UsageDimension[] = [
  'key',
  'model',
  'provider',
  'client',
  'agent',
];

export interface UsageRange {
  from: string;
  to: string;
}

/** Inclusive `YYYY-MM-DD` UTC days. */
export interface CustomDays {
  fromDate: string;
  toDate: string;
}

export interface UsageReportData {
  range: UsageRange;
  bucket: UsageBucket;
  dimension: UsageDimension;
  /** `group=none`, bucketed: KPIs and token types. */
  timeline: UsageAggregateRow[];
  /** `group=<dimension>`, bucketed: stacked charts. */
  byGroup: UsageAggregateRow[];
  /** `group=<dimension>`, no bucket: breakdown table and series order. */
  groupTotals: UsageAggregateRow[];
  meta: UsageMeta | null;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const PRESET_MS: Record<Exclude<RangePreset, 'custom'>, number> = {
  '24h': DAY_MS,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS,
};
/** Hourly bars beyond this many days are unreadable; the UI only offers days past it. */
export const MAX_HOURLY_DAYS = 31;

const dayStartMs = (date: string): number =>
  /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00Z`) : NaN;

export function resolveRange(
  preset: RangePreset,
  nowMs: number,
  custom?: CustomDays
): UsageRange | null {
  if (preset !== 'custom') {
    return {
      from: new Date(nowMs - PRESET_MS[preset]).toISOString(),
      to: new Date(nowMs).toISOString(),
    };
  }
  const from = dayStartMs(custom?.fromDate ?? '');
  const to = dayStartMs(custom?.toDate ?? '') + DAY_MS;
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

const spanMs = (range: UsageRange) => Date.parse(range.to) - Date.parse(range.from);

export const autoBucket = (range: UsageRange): UsageBucket =>
  spanMs(range) <= 2 * DAY_MS ? 'hour' : 'day';

export const hourlyAllowed = (range: UsageRange): boolean =>
  spanMs(range) <= MAX_HOURLY_DAYS * DAY_MS;

/** UTC-aligned bucket starts covering [from, to), matching the API's bucketing. */
export function bucketStarts(range: UsageRange, bucket: UsageBucket): string[] {
  const step = bucket === 'hour' ? HOUR_MS : DAY_MS;
  const end = Date.parse(range.to);
  const starts: string[] = [];
  for (let t = Math.floor(Date.parse(range.from) / step) * step; t < end; t += step) {
    starts.push(new Date(t).toISOString());
  }
  return starts;
}

const SUM_FIELDS = [
  'requests',
  'failed',
  'inputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'outputTokens',
  'reasoningTokens',
  'totalTokens',
  'listCostUsd',
  'billedCostUsd',
] as const;

export function sumTotals(rows: readonly UsageTotals[]): UsageTotals {
  const totals: UsageTotals = {
    requests: 0,
    failed: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    listCostUsd: 0,
    billedCostUsd: 0,
    avgLatencyMs: 0,
  };
  let latencyWeight = 0;
  for (const row of rows) {
    for (const field of SUM_FIELDS) totals[field] += row[field];
    latencyWeight += row.avgLatencyMs * row.requests;
  }
  totals.avgLatencyMs = totals.requests > 0 ? latencyWeight / totals.requests : 0;
  return totals;
}

/** Failure rate in percent, or null with no requests. */
export const failureRate = (totals: UsageTotals): number | null =>
  totals.requests > 0 ? (totals.failed / totals.requests) * 100 : null;

/** Series slots shown in colour; the rest fold into Other (one neutral slot). */
export const SERIES_LIMIT = 7;
export const OTHER_SERIES = '__other__';

/**
 * Group names by list cost, then tokens, then requests, highest first. The same order colours the
 * stacked charts and the breakdown table, so one entity keeps one colour across the page.
 */
export function rankSeries(totals: readonly UsageAggregateRow[], limit = SERIES_LIMIT): string[] {
  return [...totals]
    .filter((row) => row.group !== null)
    .sort(
      (a, b) =>
        b.listCostUsd - a.listCostUsd ||
        b.totalTokens - a.totalTokens ||
        b.requests - a.requests ||
        String(a.group).localeCompare(String(b.group))
    )
    .slice(0, limit)
    .map((row) => row.group as string);
}

export interface StackColumn {
  t: string;
  values: number[];
  total: number;
}

export interface Stack {
  series: string[];
  columns: StackColumn[];
  max: number;
}

function stack(
  starts: readonly string[],
  series: string[],
  rows: readonly UsageAggregateRow[],
  add: (row: UsageAggregateRow, values: number[]) => void
): Stack {
  const index = new Map(starts.map((t, i) => [Date.parse(t), i]));
  const columns = starts.map((t) => ({ t, values: series.map(() => 0), total: 0 }));
  for (const row of rows) {
    const column = row.t === null ? undefined : columns[index.get(Date.parse(row.t)) ?? -1];
    if (column) add(row, column.values);
  }
  for (const column of columns) column.total = column.values.reduce((sum, v) => sum + v, 0);
  return { series, columns, max: Math.max(0, ...columns.map((column) => column.total)) };
}

export function stackByGroup(
  rows: readonly UsageAggregateRow[],
  starts: readonly string[],
  ranked: readonly string[],
  metric: (row: UsageAggregateRow) => number
): Stack {
  const slot = new Map(ranked.map((name, i) => [name, i]));
  const hasOther = rows.some((row) => !slot.has(row.group ?? '') && metric(row) > 0);
  const series = hasOther ? [...ranked, OTHER_SERIES] : [...ranked];
  return stack(starts, series, rows, (row, values) => {
    values[slot.get(row.group ?? '') ?? ranked.length] += metric(row);
  });
}

export const TOKEN_TYPES = ['input', 'cache_read', 'cache_write', 'output', 'reasoning'] as const;

/** Output includes reasoning in the API; split it so the stack adds up to the total. */
export const stackByTokenType = (rows: readonly UsageAggregateRow[], starts: readonly string[]) =>
  stack(starts, [...TOKEN_TYPES], rows, (row, values) => {
    values[0] += row.inputTokens;
    values[1] += row.cacheReadTokens;
    values[2] += row.cacheWriteTokens;
    values[3] += Math.max(0, row.outputTokens - row.reasoningTokens);
    values[4] += row.reasoningTokens;
  });

export function formatUsd(value: number): string {
  if (value > 0 && value < 0.01) return '<$0.01';
  if (Math.abs(value) >= 100_000) return `$${formatCompactNumber(value)}`;
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export const formatTokens = formatCompactNumber;

/** Bucket label in UTC, matching the API's bucketing (hour: "11-04 13:00", day: "2026-11-04"). */
export function formatBucket(t: string, bucket: UsageBucket): string {
  const iso = new Date(t).toISOString();
  return bucket === 'day' ? iso.slice(0, 10) : `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
}

/** Request timestamp in UTC, to the second. */
export const formatTimestamp = (ts: string): string => {
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 19).replace('T', ' ') : ts;
};

/** `provider` groups are `provider/auth_type`. */
export function splitProviderGroup(group: string): { provider: string; authType: string } {
  const slash = group.lastIndexOf('/');
  return slash < 0
    ? { provider: group, authType: '' }
    : { provider: group.slice(0, slash), authType: group.slice(slash + 1) };
}

export type SessionSort = 'recent' | 'cost';

/** Whole minutes between first and last activity, or null when a time is missing. */
export function sessionMinutes(firstTs: string, lastTs: string): number | null {
  const span = Date.parse(lastTs) - Date.parse(firstTs);
  return Number.isFinite(span) ? Math.max(0, Math.floor(span / 60_000)) : null;
}

export const shortSessionId = (id: string): string => id.slice(0, 8);

/** The server fails open (enforces nothing) once its checker is this far behind. */
export const QUOTA_STALE_MS = 2 * 60_000;

export interface QuotaWindowRow {
  window: QuotaWindow;
  used: number;
  limit: number;
  /** Whole percent of the limit used; can exceed 100. */
  percent: number;
}

export interface QuotaRow {
  key: string;
  windows: QuotaWindowRow[];
  /** UTC end of the block: "HH:MM", with the date when it is not today (UTC). */
  blocked: { time: string; window: QuotaWindow | null } | null;
}

export interface QuotaView {
  stale: boolean;
  rows: QuotaRow[];
}

export function quotaRows(quotas: UsageQuotas, nowMs: number): QuotaView {
  const updated = quotas.updated ? Date.parse(quotas.updated) : NaN;
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const rows = Object.entries(quotas.keys)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, quota]): QuotaRow => {
      const until = quota.blockedUntil ? Date.parse(quota.blockedUntil) : NaN;
      // A block in the past has ended; the page only refreshes on demand.
      const iso = until > nowMs ? new Date(until).toISOString() : '';
      return {
        key,
        windows: QUOTA_WINDOWS.flatMap((window) => {
          const limit = quota.limits[window];
          if (!limit) return [];
          const used = quota.used[window];
          return [{ window, used, limit, percent: Math.round((used / limit) * 100) }];
        }),
        blocked: iso
          ? {
              time: iso.startsWith(today)
                ? iso.slice(11, 16)
                : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`,
              window: quota.blockedWindow,
            }
          : null,
      };
    });
  return { stale: !(nowMs - updated <= QUOTA_STALE_MS), rows };
}
