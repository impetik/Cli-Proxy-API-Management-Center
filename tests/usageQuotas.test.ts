import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../src/i18n/index';
import { normalizeQuotas, usageApi } from '@/services/api/usage';
import { quotaRows } from '@/features/usage/logic';
import { QuotasCard } from '@/features/usage/components/QuotasCard';

const NOW = Date.parse('2026-11-19T00:10:30.000Z');

const RAW_QUOTAS = {
  updated: '2026-11-19T00:10:00.000Z',
  keys: {
    'laptop-ali': {
      limits: { '5h': 5, day: 20 },
      used: { '5h': 3.1, day: 7.4 },
      blocked_until: null,
      blocked_window: null,
    },
    desk: {
      limits: { day: 2.5, '5h': 0 },
      used: { '5h': 0.4, day: 2.6 },
      blocked_until: '2026-11-19T14:05:00.000Z',
      blocked_window: 'day',
    },
    broken: 'not an object',
  },
};

describe('quota normalisation', () => {
  test('keeps positive limits only, both used windows, and blocked state', () => {
    const quotas = normalizeQuotas(RAW_QUOTAS);
    expect(quotas.updated).toBe('2026-11-19T00:10:00.000Z');
    expect(Object.keys(quotas.keys)).toEqual(['laptop-ali', 'desk']);
    expect(quotas.keys.desk).toEqual({
      limits: { day: 2.5 },
      used: { '5h': 0.4, day: 2.6 },
      blockedUntil: '2026-11-19T14:05:00.000Z',
      blockedWindow: 'day',
    });
  });

  test('garbage and empty payloads become no keys', () => {
    expect(normalizeQuotas(null)).toEqual({ updated: null, keys: {} });
    expect(normalizeQuotas({ updated: 'x', keys: {} }).keys).toEqual({});
  });
});

describe('quota display rows', () => {
  test('rows are sorted by key with per-window percentages and a blocked label', () => {
    const view = quotaRows(normalizeQuotas(RAW_QUOTAS), NOW);
    expect(view.stale).toBe(false);
    expect(view.rows.map((row) => row.key)).toEqual(['desk', 'laptop-ali']);
    const [desk, laptop] = view.rows;
    expect(laptop.windows).toEqual([
      { window: '5h', used: 3.1, limit: 5, percent: 62 },
      { window: 'day', used: 7.4, limit: 20, percent: 37 },
    ]);
    expect(laptop.blocked).toBe(null);
    // Missing 5h limit: only the day window shows; over-limit percent is not clamped.
    expect(desk.windows).toEqual([{ window: 'day', used: 2.6, limit: 2.5, percent: 104 }]);
    expect(desk.blocked).toEqual({ time: '14:05', window: 'day' });
  });

  test('a block ending on another UTC day carries the date', () => {
    const quotas = normalizeQuotas({
      ...RAW_QUOTAS,
      keys: { desk: { ...RAW_QUOTAS.keys.desk, blocked_until: '2026-11-20T00:05:00.000Z' } },
    });
    expect(quotaRows(quotas, NOW).rows[0].blocked?.time).toBe('2026-11-20 00:05');
  });

  test('a block that has already ended is not shown', () => {
    const ended = Date.parse('2026-11-19T14:05:00.000Z');
    const rows = quotaRows(normalizeQuotas(RAW_QUOTAS), ended).rows;
    expect(rows.find((r) => r.key === 'desk')!.blocked).toBe(null);
  });

  test('stale after two minutes or when the checker never ran', () => {
    const quotas = normalizeQuotas(RAW_QUOTAS);
    expect(quotaRows(quotas, Date.parse('2026-11-19T00:12:00.000Z')).stale).toBe(false);
    expect(quotaRows(quotas, Date.parse('2026-11-19T00:12:00.001Z')).stale).toBe(true);
    expect(quotaRows({ updated: null, keys: quotas.keys }, NOW).stale).toBe(true);
  });

  test('no keys means no rows', () => {
    expect(quotaRows({ updated: '2026-11-19T00:10:00.000Z', keys: {} }, NOW).rows).toEqual([]);
  });
});

describe('quota API', () => {
  let fetchSpy: ReturnType<typeof spyOn> | null = null;
  afterEach(() => fetchSpy?.mockRestore());

  test('reads /usage/quotas on port 8318 with the bearer key', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(RAW_QUOTAS), { status: 200 })
    );
    const quotas = await usageApi.quotas({ apiBase: 'http://host:8317', managementKey: 'k' });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://host:8318/usage/quotas');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k');
    expect(Object.keys(quotas.keys)).toHaveLength(2);
  });
});

describe('quota card rendering', () => {
  const initialLanguage = i18n.language;
  beforeAll(async () => {
    await i18n.changeLanguage('en');
  });
  afterAll(async () => {
    await i18n.changeLanguage(initialLanguage);
  });

  const render = (nowMs: number, quotas = normalizeQuotas(RAW_QUOTAS)) =>
    renderToStaticMarkup(createElement(QuotasCard, { view: quotaRows(quotas, nowMs) }));

  test('shows spend of limit per window, accessible meters and a text blocked badge', () => {
    const html = render(NOW);
    expect(html).toContain('Quotas');
    expect(html).toContain('5 h: $3.10 of $5.00');
    expect(html).toContain('24 h: $7.40 of $20.00');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="62"');
    expect(html).toContain('aria-label="laptop-ali, 5 h: 62%"');
    expect(html).toContain('Blocked until 14:05 UTC (24-hour limit)');
    expect(html).toContain('keytool.sh limit');
    expect(html).not.toContain('stale');
  });

  test('warns when quota data is stale', () => {
    expect(render(Date.parse('2026-11-19T00:20:00.000Z'))).toContain('Quota data is stale');
  });

  test('renders nothing without keys', () => {
    expect(render(NOW, { updated: RAW_QUOTAS.updated, keys: {} })).toBe('');
  });
});
