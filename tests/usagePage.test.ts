import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../src/i18n/index';
import {
  UsageApiError,
  normalizeAggregate,
  normalizeMeta,
  normalizeRequests,
  normalizeSessions,
} from '@/services/api/usage';
import { UsageReport } from '@/features/usage/components/UsageReport';
import { RequestsTable } from '@/features/usage/components/RequestsTable';
import { UsageStatus } from '@/features/usage/components/UsageStatus';
import { SessionsTable } from '@/features/usage/components/SessionsTable';
import type { UsageReportData } from '@/features/usage/logic';
import {
  RAW_KEY_BY_HOUR,
  RAW_KEY_TOTALS,
  RAW_META,
  RAW_NONE_BY_HOUR,
  RAW_REQUESTS,
  RAW_SESSIONS,
} from './fixtures/usage';

const DATA: UsageReportData = {
  range: { from: '2026-11-04T00:00:00Z', to: '2026-11-04T03:00:00Z' },
  bucket: 'hour',
  dimension: 'key',
  timeline: normalizeAggregate(RAW_NONE_BY_HOUR),
  byGroup: normalizeAggregate(RAW_KEY_BY_HOUR),
  groupTotals: normalizeAggregate(RAW_KEY_TOTALS),
  meta: normalizeMeta(RAW_META),
};

const noop = () => {};
const initialLanguage = i18n.language;
beforeAll(async () => {
  await i18n.changeLanguage('en');
});
afterAll(async () => {
  await i18n.changeLanguage(initialLanguage);
});

describe('usage report rendering', () => {
  // Rendered lazily: describe bodies run before beforeAll switches the language.
  let html = '';
  beforeAll(() => {
    html = renderToStaticMarkup(
      createElement(UsageReport, { data: DATA, onDimensionChange: noop })
    );
  });

  test('KPI tiles show requests, tokens, both costs and the failure rate', () => {
    expect(html).toContain('API list-price equivalent');
    expect(html).toContain('$0.62');
    expect(html).toContain('$0.10');
    expect(html).toContain('6.3%');
    expect(html).toContain('>16<');
  });

  test('charts have accessible names, a legend and a data table fallback', () => {
    expect(html).toMatch(/role="img" aria-label="[^"]*List-price cost[^"]*"/);
    expect(html).toMatch(/role="img" aria-label="[^"]*Token types[^"]*"/);
    expect(html).toContain('dirso-builder-staging');
    expect(html).toContain('Cache read');
    expect(html).toContain('Reasoning');
    expect(html).toContain('<table');
    expect(html).toContain('Show numbers');
  });

  test('the stack switch offers every dimension and marks the active one', () => {
    for (const label of ['Key', 'Model', 'Provider', 'Machine', 'Agent']) {
      expect(html).toContain(`>${label}<`);
    }
    expect(html).toMatch(/aria-pressed="true"[^>]*>Key</);
  });

  test('an empty range says when history starts instead of drawing empty charts', () => {
    const empty = renderToStaticMarkup(
      createElement(UsageReport, {
        data: { ...DATA, timeline: [], byGroup: [], groupTotals: [] },
        onDimensionChange: noop,
      })
    );
    expect(empty).toContain('No usage in this range');
    expect(empty).toContain('2026-11-04');
    expect(empty).not.toContain('role="img"');
  });

  test('provider rows say whether the account is a subscription or an API key', () => {
    const providers = renderToStaticMarkup(
      createElement(UsageReport, {
        data: {
          ...DATA,
          dimension: 'provider',
          byGroup: [],
          groupTotals: normalizeAggregate({
            rows: [
              { group: 'claude/oauth', requests: 3, list_cost_usd: 1 },
              { group: 'openrouter/apikey', requests: 1, billed_cost_usd: 0.2 },
            ],
          }),
        },
        onDimensionChange: noop,
      })
    );
    expect(providers).toContain('Subscription');
    expect(providers).toContain('API key');
  });
});

describe('recent requests and status rendering', () => {
  test('requests table shows who, where from, what and how it went', () => {
    const html = renderToStaticMarkup(
      createElement(RequestsTable, {
        rows: normalizeRequests(RAW_REQUESTS),
        meta: normalizeMeta(RAW_META),
        filters: { key: '', model: '', client: '', session: '' },
        onFiltersChange: noop,
        loading: false,
      })
    );
    for (const text of ['macbook', '100.64.0.10', 'claude-code', 'claude-opus-5-5', '502']) {
      expect(html).toContain(text);
    }
  });

  test('401 and unreachable API get distinct explanations', () => {
    const unauthorized = renderToStaticMarkup(
      createElement(UsageStatus, {
        error: new UsageApiError('HTTP 401', 401),
        base: 'http://100.90.164.91:8318',
        onRetry: noop,
      })
    );
    expect(unauthorized).toContain('management key');
    const down = renderToStaticMarkup(
      createElement(UsageStatus, {
        error: new UsageApiError('Failed to fetch', null),
        base: 'http://100.90.164.91:8318',
        onRetry: noop,
      })
    );
    expect(down).toContain('http://100.90.164.91:8318');
    expect(down).not.toContain('management key');
  });
});

describe('sessions rendering', () => {
  const sessions = normalizeSessions(RAW_SESSIONS);
  const render = (selected: string) =>
    renderToStaticMarkup(
      createElement(SessionsTable, {
        rows: sessions,
        sort: 'recent',
        onSortChange: noop,
        selected,
        onSelect: noop,
        loading: false,
        error: null,
      })
    );

  test('rows show who, where, which models and the totals, with a short id and the full id on hover', () => {
    const html = render('');
    for (const text of [
      'ali',
      'macbook',
      'claude-code',
      'claude-opus-5-5, claude-haiku-5-5',
      '$0.30',
    ]) {
      expect(html).toContain(text);
    }
    expect(html).toContain('>3f2a9c1e<');
    expect(html).toContain('title="3f2a9c1e-7b4d-4e2a-9f10-aa11bb22cc33"');
    expect(html).toContain('aria-label="Copy session id 3f2a9c1e-7b4d-4e2a-9f10-aa11bb22cc33"');
    expect(html).toContain('1 h 10 m');
    expect(html).toContain('Less than a minute');
    expect(html).toMatch(/aria-pressed="true"[^>]*>Most recent</);
  });

  test('rows keep the order the API sorted them in', () => {
    const html = render('');
    expect(html.indexOf('>3f2a9c1e<')).toBeLessThan(html.indexOf('>b7c8d9e0<'));
    const reversed = renderToStaticMarkup(
      createElement(SessionsTable, {
        rows: [...sessions].reverse(),
        sort: 'recent',
        onSortChange: noop,
        selected: '',
        onSelect: noop,
        loading: false,
        error: null,
      })
    );
    expect(reversed.indexOf('>b7c8d9e0<')).toBeLessThan(reversed.indexOf('>3f2a9c1e<'));
  });

  test('the selected session is pressed and every other one is not', () => {
    const html = render('3f2a9c1e-7b4d-4e2a-9f10-aa11bb22cc33');
    expect(html).toMatch(/aria-pressed="true"[^>]*title="3f2a9c1e-[^"]*"/);
    expect(html).toMatch(/aria-pressed="false"[^>]*title="b7c8d9e0-[^"]*"/);
  });

  test('the requests table shows a removable session chip while a session filter is on', () => {
    const html = renderToStaticMarkup(
      createElement(RequestsTable, {
        rows: [],
        meta: null,
        filters: {
          key: '',
          model: '',
          client: '',
          session: '3f2a9c1e-7b4d-4e2a-9f10-aa11bb22cc33',
        },
        onFiltersChange: noop,
        loading: false,
      })
    );
    expect(html).toContain('Session: 3f2a9c1e');
    expect(html).toContain('aria-label="Clear the session filter"');
  });
});

describe('usage wiring', () => {
  test('route and sidebar entry exist', () => {
    expect(readFileSync('src/router/MainRoutes.tsx', 'utf8')).toContain(
      "{ path: '/usage', element: <UsagePage /> }"
    );
    const layout = readFileSync('src/components/layout/MainLayout.tsx', 'utf8');
    expect(layout).toContain("labelKey: 'nav.usage'");
    expect(layout).toContain("metaKey: 'nav_meta.usage'");
  });

  test('every locale carries every usage key', async () => {
    type Tree = Record<string, unknown>;
    const leaves = (tree: unknown, prefix = ''): string[] =>
      tree && typeof tree === 'object'
        ? Object.entries(tree as Tree).flatMap(([key, child]) =>
            leaves(child, prefix ? `${prefix}.${key}` : key)
          )
        : [prefix];
    const load = async (name: string) =>
      (await Bun.file(`src/i18n/locales/${name}.json`).json()) as Tree;
    const en = await load('en');
    const wanted = [...leaves(en.usage, 'usage'), 'nav.usage', 'nav_meta.usage'];
    for (const name of ['zh-CN', 'zh-TW', 'ru', 'vi', 'ko', 'tr']) {
      const locale = await load(name);
      const have = new Set([
        ...leaves(locale.usage, 'usage'),
        ...leaves(locale.nav, 'nav'),
        ...leaves(locale.nav_meta, 'nav_meta'),
      ]);
      expect({ name, missing: wanted.filter((key) => !have.has(key)) }).toEqual({
        name,
        missing: [],
      });
    }
  });
});
