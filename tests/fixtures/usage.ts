/** Raw usage API payloads, shaped like docs/usage-api.md. No real keys or IPs. */

const tokens = (
  input: number,
  cacheRead: number,
  cacheWrite: number,
  output: number,
  reasoning = 0
) => ({
  input_tokens: input,
  cache_read_tokens: cacheRead,
  cache_write_tokens: cacheWrite,
  output_tokens: output,
  reasoning_tokens: reasoning,
  total_tokens: input + cacheRead + cacheWrite + output,
});

export const RAW_KEY_BY_HOUR = {
  from: '2026-11-04T00:00:00Z',
  to: '2026-11-04T03:00:00Z',
  group: 'key',
  bucket: 'hour',
  rows: [
    {
      t: '2026-11-04T00:00:00Z',
      group: 'ali',
      requests: 10,
      failed: 1,
      ...tokens(1000, 4000, 500, 300, 100),
      list_cost_usd: 0.5,
      billed_cost_usd: 0,
      avg_latency_ms: 1200,
    },
    {
      t: '2026-11-04T00:00:00Z',
      group: 'dirso-builder-staging',
      requests: 4,
      failed: 0,
      ...tokens(200, 0, 0, 100),
      list_cost_usd: 0.1,
      billed_cost_usd: 0.1,
      avg_latency_ms: 800,
    },
    // 01:00 has no traffic at all: the chart must still show the empty bucket.
    {
      t: '2026-11-04T02:00:00Z',
      group: 'ali',
      requests: 2,
      failed: 0,
      ...tokens(100, 0, 0, 50),
      list_cost_usd: 0.02,
      billed_cost_usd: 0,
      avg_latency_ms: 400,
    },
  ],
};

export const RAW_KEY_TOTALS = {
  from: '2026-11-04T00:00:00Z',
  to: '2026-11-04T03:00:00Z',
  group: 'key',
  rows: [
    {
      group: 'ali',
      requests: 12,
      failed: 1,
      ...tokens(1100, 4000, 500, 350, 100),
      list_cost_usd: 0.52,
      billed_cost_usd: 0,
      avg_latency_ms: 1066.7,
    },
    {
      group: 'dirso-builder-staging',
      requests: 4,
      failed: 0,
      ...tokens(200, 0, 0, 100),
      list_cost_usd: 0.1,
      billed_cost_usd: 0.1,
      avg_latency_ms: 800,
    },
  ],
};

export const RAW_NONE_BY_HOUR = {
  from: '2026-11-04T00:00:00Z',
  to: '2026-11-04T03:00:00Z',
  bucket: 'hour',
  rows: [
    {
      t: '2026-11-04T00:00:00Z',
      requests: 14,
      failed: 1,
      ...tokens(1200, 4000, 500, 400, 100),
      list_cost_usd: 0.6,
      billed_cost_usd: 0.1,
      avg_latency_ms: 1085.7,
    },
    {
      t: '2026-11-04T02:00:00Z',
      requests: 2,
      failed: 0,
      ...tokens(100, 0, 0, 50),
      list_cost_usd: 0.02,
      billed_cost_usd: 0,
      avg_latency_ms: 400,
    },
  ],
};

export const RAW_REQUESTS = {
  rows: [
    {
      ts: '2026-11-04T02:10:00Z',
      key: 'ali',
      client: 'macbook',
      client_ip: '100.64.0.10',
      agent: 'claude-code',
      user_agent: 'claude-cli/2.1 (external, cli)',
      provider: 'claude',
      auth_type: 'oauth',
      model: 'claude-opus-5-5',
      endpoint: '/v1/messages',
      ...tokens(100, 0, 0, 50),
      list_cost_usd: 0.02,
      billed_cost_usd: 0,
      latency_ms: 400,
      failed: false,
      status_code: 200,
    },
    {
      ts: '2026-11-04T00:05:00Z',
      key: 'dirso-builder-staging',
      client: '',
      client_ip: '100.64.0.20',
      agent: 'node',
      user_agent: 'node',
      provider: 'openrouter',
      auth_type: 'apikey',
      model: 'some/model',
      endpoint: '/v1/responses',
      input_tokens: '12',
      list_cost_usd: null,
      latency_ms: 'n/a',
      failed: 1,
      status_code: 502,
    },
  ],
};

export const RAW_META = {
  first_ts: '2026-11-04T00:00:12Z',
  last_ts: '2026-11-04T02:10:00Z',
  keys: ['ali', 'dirso-builder-staging', 7, null],
  models: ['claude-opus-5-5'],
  clients: ['macbook'],
  pricing: {
    source: 'openrouter',
    fetched_at: '2026-11-04T00:00:00Z',
    unpriced_models: ['mystery-model'],
  },
};
