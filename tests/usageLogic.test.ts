import { describe, expect, test } from 'bun:test';
import { normalizeAggregate, normalizeSessions } from '@/services/api/usage';
import {
  OTHER_SERIES,
  autoBucket,
  bucketStarts,
  failureRate,
  sessionMinutes,
  formatUsd,
  shortSessionId,
  rankSeries,
  resolveRange,
  splitProviderGroup,
  stackByGroup,
  stackByTokenType,
  sumTotals,
} from '@/features/usage/logic';
import { RAW_KEY_BY_HOUR, RAW_KEY_TOTALS, RAW_NONE_BY_HOUR, RAW_SESSIONS } from './fixtures/usage';

const NOW = Date.parse('2026-11-04T12:34:56Z');

describe('usage range', () => {
  test('presets end now and pick hour buckets up to two days, then day buckets', () => {
    expect(resolveRange('24h', NOW)).toEqual({
      from: '2026-11-03T12:34:56.000Z',
      to: '2026-11-04T12:34:56.000Z',
    });
    expect(resolveRange('7d', NOW)?.from).toBe('2026-10-28T12:34:56.000Z');
    expect(autoBucket(resolveRange('24h', NOW)!)).toBe('hour');
    expect(autoBucket(resolveRange('7d', NOW)!)).toBe('day');
    expect(autoBucket(resolveRange('30d', NOW)!)).toBe('day');
  });

  test('custom ranges are whole UTC days with an inclusive end day', () => {
    expect(resolveRange('custom', NOW, { fromDate: '2026-11-01', toDate: '2026-11-03' })).toEqual({
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-11-04T00:00:00.000Z',
    });
    expect(resolveRange('custom', NOW, { fromDate: '2026-11-03', toDate: '2026-11-01' })).toBe(
      null
    );
    expect(resolveRange('custom', NOW, { fromDate: '', toDate: '2026-11-01' })).toBe(null);
  });

  test('bucket starts are aligned to UTC and cover the range including a partial first bucket', () => {
    expect(
      bucketStarts({ from: '2026-11-04T00:30:00Z', to: '2026-11-04T03:00:00Z' }, 'hour')
    ).toEqual(['2026-11-04T00:00:00.000Z', '2026-11-04T01:00:00.000Z', '2026-11-04T02:00:00.000Z']);
    expect(
      bucketStarts({ from: '2026-11-01T05:00:00Z', to: '2026-11-03T01:00:00Z' }, 'day')
    ).toEqual(['2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z', '2026-11-03T00:00:00.000Z']);
  });
});

describe('usage aggregation', () => {
  const byHour = normalizeAggregate(RAW_KEY_BY_HOUR);
  const totals = normalizeAggregate(RAW_KEY_TOTALS);
  const starts = bucketStarts({ from: '2026-11-04T00:00:00Z', to: '2026-11-04T03:00:00Z' }, 'hour');

  test('totals sum every field and weight latency by requests', () => {
    const sum = sumTotals(normalizeAggregate(RAW_NONE_BY_HOUR));
    expect(sum.requests).toBe(16);
    expect(sum.failed).toBe(1);
    expect(sum.listCostUsd).toBeCloseTo(0.62);
    expect(sum.billedCostUsd).toBeCloseTo(0.1);
    expect(sum.avgLatencyMs).toBeCloseTo((1085.7 * 14 + 400 * 2) / 16);
    expect(failureRate(sum)).toBeCloseTo(100 / 16);
    expect(failureRate(sumTotals([]))).toBeNull();
  });

  test('series rank by list cost and fold the tail into Other', () => {
    expect(rankSeries(totals, 7)).toEqual(['ali', 'dirso-builder-staging']);
    expect(rankSeries(totals, 1)).toEqual(['ali']);
  });

  test('stacking fills empty buckets and keeps unranked groups in Other', () => {
    const stack = stackByGroup(byHour, starts, ['ali'], (row) => row.listCostUsd);
    expect(stack.series).toEqual(['ali', OTHER_SERIES]);
    expect(stack.columns.map((column) => column.values)).toEqual([
      [0.5, 0.1],
      [0, 0],
      [0.02, 0],
    ]);
    expect(stack.columns[1].total).toBe(0);
    expect(stack.max).toBeCloseTo(0.6);

    const noOther = stackByGroup(
      byHour,
      starts,
      ['ali', 'dirso-builder-staging'],
      (row) => row.requests
    );
    expect(noOther.series).toEqual(['ali', 'dirso-builder-staging']);
  });

  test('token types split output into visible output and reasoning', () => {
    const stack = stackByTokenType(normalizeAggregate(RAW_NONE_BY_HOUR), starts);
    expect(stack.series).toEqual(['input', 'cache_read', 'cache_write', 'output', 'reasoning']);
    expect(stack.columns[0].values).toEqual([1200, 4000, 500, 300, 100]);
    expect(stack.columns[0].total).toBe(6100);
  });
});

describe('usage formatting', () => {
  test('dollars keep cents, show tiny spend as below a cent and compact large sums', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.004)).toBe('<$0.01');
    expect(formatUsd(12.345)).toBe('$12.35');
    expect(formatUsd(1234.5)).toBe('$1,234.50');
    expect(formatUsd(123456)).toBe('$123K');
  });

  test('provider groups split into provider and auth type', () => {
    expect(splitProviderGroup('claude/oauth')).toEqual({ provider: 'claude', authType: 'oauth' });
    expect(splitProviderGroup('openrouter')).toEqual({ provider: 'openrouter', authType: '' });
  });
});

describe('usage sessions logic', () => {
  const sessions = normalizeSessions(RAW_SESSIONS);

  test('durations are whole minutes, and short ids keep the first eight characters', () => {
    expect(sessionMinutes('2026-11-04T01:00:00Z', '2026-11-04T02:10:00Z')).toBe(70);
    expect(sessionMinutes('2026-11-04T01:00:00Z', '2026-11-04T01:12:40Z')).toBe(12);
    expect(sessionMinutes('2026-11-04T00:05:00Z', '2026-11-04T00:05:30Z')).toBe(0);
    expect(sessionMinutes('', 'x')).toBeNull();
    expect(shortSessionId('3f2a9c1e-7b4d-4e2a-9f10-aa11bb22cc33')).toBe('3f2a9c1e');
    expect(shortSessionId('short')).toBe('short');
  });
});
