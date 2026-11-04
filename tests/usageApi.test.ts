import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  UsageApiError,
  normalizeAggregate,
  normalizeMeta,
  normalizeRequests,
  normalizeSessions,
  usageApi,
  usageApiBase,
} from '@/services/api/usage';
import {
  RAW_KEY_BY_HOUR,
  RAW_META,
  RAW_NONE_BY_HOUR,
  RAW_REQUESTS,
  RAW_SESSIONS,
} from './fixtures/usage';

const CONN = { apiBase: 'http://100.90.164.91:8317', managementKey: 'test-key' };

const restores: Array<{ mockRestore: () => void }> = [];
afterEach(() => restores.splice(0).forEach((spy) => spy.mockRestore()));

const mockFetch = (impl: (url: string, init?: RequestInit) => Promise<Response>) => {
  const spy = spyOn(globalThis, 'fetch').mockImplementation(
    impl as unknown as typeof globalThis.fetch
  );
  restores.push(spy);
  return spy;
};

describe('usage API base', () => {
  test('keeps the connection host and protocol and swaps the port to 8318', () => {
    expect(usageApiBase('http://100.90.164.91:8317')).toBe('http://100.90.164.91:8318');
    expect(usageApiBase('100.90.164.91:8317/v8/management')).toBe('http://100.90.164.91:8318');
    expect(usageApiBase('https://proxy.example.test')).toBe('https://proxy.example.test:8318');
    expect(usageApiBase('')).toBe('');
  });
});

describe('usage API normalisation', () => {
  test('aggregate rows become camelCase numbers, keeping bucket and group only when present', () => {
    const keyed = normalizeAggregate(RAW_KEY_BY_HOUR);
    expect(keyed).toHaveLength(3);
    expect(keyed[0]).toEqual({
      t: '2026-11-04T00:00:00Z',
      group: 'ali',
      requests: 10,
      failed: 1,
      inputTokens: 1000,
      cacheReadTokens: 4000,
      cacheWriteTokens: 500,
      outputTokens: 300,
      reasoningTokens: 100,
      totalTokens: 5800,
      listCostUsd: 0.5,
      billedCostUsd: 0,
      avgLatencyMs: 1200,
    });
    const none = normalizeAggregate(RAW_NONE_BY_HOUR);
    expect(none[0].group).toBeNull();
    expect(normalizeAggregate(null)).toEqual([]);
    expect(normalizeAggregate({ rows: [null, 'x'] })).toEqual([]);
  });

  test('request rows coerce bad numbers to zero and failure flags to booleans', () => {
    const rows = normalizeRequests(RAW_REQUESTS);
    expect(rows[0]).toMatchObject({
      ts: '2026-11-04T02:10:00Z',
      key: 'ali',
      client: 'macbook',
      clientIp: '100.64.0.10',
      agent: 'claude-code',
      authType: 'oauth',
      model: 'claude-opus-5-5',
      totalTokens: 150,
      latencyMs: 400,
      failed: false,
      statusCode: 200,
    });
    expect(rows[1]).toMatchObject({
      client: '',
      inputTokens: 12,
      listCostUsd: 0,
      latencyMs: 0,
      failed: true,
      statusCode: 502,
    });
    expect(normalizeRequests([])).toEqual([]);
  });

  test('meta keeps only string list entries', () => {
    expect(normalizeMeta(RAW_META)).toEqual({
      firstTs: '2026-11-04T00:00:12Z',
      keys: ['ali', 'dirso-builder-staging'],
      models: ['claude-opus-5-5'],
      clients: ['macbook'],
      pricing: { unpricedModels: ['mystery-model'] },
    });
    expect(normalizeMeta({}).firstTs).toBeNull();
  });
});

describe('usage sessions', () => {
  test('session rows keep identity, string models only and the aggregate fields', () => {
    const [first, second] = normalizeSessions(RAW_SESSIONS);
    expect(first).toMatchObject({
      session: '3f2a9c1e-7b4d-4e2a-9f10-aa11bb22cc33',
      firstTs: '2026-11-04T01:00:00Z',
      lastTs: '2026-11-04T02:10:00Z',
      key: 'ali',
      client: 'macbook',
      agent: 'claude-code',
      models: ['claude-opus-5-5', 'claude-haiku-5-5'],
      requests: 9,
      totalTokens: 2800,
      listCostUsd: 0.3,
    });
    expect(second.models).toEqual([]);
    expect(normalizeSessions(null)).toEqual([]);
  });

  test('request rows carry their session and the requests endpoint filters by it', async () => {
    expect(normalizeRequests({ rows: [{ session: 'abc' }, {}] }).map((r) => r.session)).toEqual([
      'abc',
      '',
    ]);
    const fetchSpy = mockFetch(async () => Response.json(RAW_SESSIONS));
    await usageApi.sessions(CONN, { from: 'a', to: 'b', limit: 100, sort: 'cost' });
    expect(fetchSpy.mock.calls[0][0]).toBe(
      'http://100.90.164.91:8318/usage/sessions?from=a&to=b&limit=100&sort=cost'
    );
    await usageApi.requests(CONN, { from: 'a', to: 'b', session: 'abc' });
    expect(fetchSpy.mock.calls[1][0]).toBe(
      'http://100.90.164.91:8318/usage/requests?from=a&to=b&session=abc'
    );
  });
});

describe('usage API requests', () => {
  test('sends the bearer key and query to port 8318, not the management prefix', async () => {
    const fetchSpy = mockFetch(async () => Response.json(RAW_KEY_BY_HOUR));
    const signal = new AbortController().signal;
    const result = await usageApi.aggregate(
      CONN,
      { from: '2026-11-04T00:00:00Z', to: '2026-11-04T03:00:00Z', group: 'key', bucket: 'hour' },
      signal
    );
    expect(result).toHaveLength(3);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'http://100.90.164.91:8318/usage/aggregate?from=2026-11-04T00%3A00%3A00Z' +
        '&to=2026-11-04T03%3A00%3A00Z&group=key&bucket=hour'
    );
    expect(url).not.toContain('/v8/management');
    expect(init.headers).toEqual({ Authorization: 'Bearer test-key' });
    expect(init.signal).toBe(signal);
  });

  test('omits empty optional filters on the requests endpoint', async () => {
    const fetchSpy = mockFetch(async () => Response.json(RAW_REQUESTS));
    await usageApi.requests(CONN, { from: 'a', to: 'b', limit: 100, key: '', model: 'm' });
    expect(fetchSpy.mock.calls[0][0]).toBe(
      'http://100.90.164.91:8318/usage/requests?from=a&to=b&limit=100&model=m'
    );
  });

  test('HTTP failures carry the status; network failures carry null', async () => {
    mockFetch(async () => new Response('nope', { status: 401 }));
    const unauthorized = await usageApi.meta(CONN).catch((error: unknown) => error);
    expect(unauthorized).toBeInstanceOf(UsageApiError);
    expect((unauthorized as UsageApiError).status).toBe(401);

    restores.splice(0).forEach((spy) => spy.mockRestore());
    mockFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    const down = await usageApi.meta(CONN).catch((error: unknown) => error);
    expect(down).toBeInstanceOf(UsageApiError);
    expect((down as UsageApiError).status).toBeNull();
  });

  test('aborts pass through untouched so callers can ignore them', async () => {
    mockFetch(async () => {
      throw new DOMException('aborted', 'AbortError');
    });
    const error = await usageApi.meta(CONN).catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(UsageApiError);
    expect((error as DOMException).name).toBe('AbortError');
  });
});
