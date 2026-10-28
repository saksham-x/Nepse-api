import { describe, expect, it, vi } from 'vitest';
import { NepseProvider, parseRetryAfter } from '../../src/modules/ingestion/providers/nepse.provider.js';
import { ProviderError } from '../../src/modules/ingestion/providers/provider-error.js';
import { securityDetail } from '../fixtures/security-detail.js';

const TOKEN = 'x'.repeat(250);
const PROVE = { accessToken: TOKEN, refreshToken: 'r', salt1: 1, salt2: 123, salt3: 3, salt4: 4, salt5: 5 };
const MARKET = { isOpen: 'CLOSE', asOf: '2024-06-12T15:00:00', id: 5 };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function setup(security: Handler, overrides: Partial<ConstructorParameters<typeof NepseProvider>[0]> = {}) {
  const calls: { path: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const path = new URL(url).pathname;
    calls.push({ path, init });
    if (path === '/api/authenticate/prove') return json(PROVE);
    if (path === '/api/nots/nepse-data/market-open') return json(MARKET);
    return security(url, init);
  }) as unknown as typeof fetch;
  const sleep = vi.fn(async () => undefined);
  const provider = new NepseProvider({
    baseUrl: 'https://nepse.test',
    timeoutMs: 1000,
    maxRetries: 2,
    retryBaseMs: 100,
    maxRetryDelayMs: 5000,
    minIntervalMs: 0,
    sessionTtlMs: 60_000,
    fetchImpl,
    sleep,
    now: () => new Date('2024-06-12T10:00:00Z'), // day 12 in Kathmandu
    ...overrides,
  });
  return { provider, calls, sleep };
}

describe('NepseProvider', () => {
  it('authenticates once and reuses the session across requests', async () => {
    const { provider, calls } = setup(() => json(securityDetail()));
    await Promise.all([provider.getSecurityDetail(397), provider.getSecurityDetail(398), provider.getSecurityDetail(399)]);
    expect(calls.filter((c) => c.path === '/api/authenticate/prove')).toHaveLength(1);
    expect(calls.filter((c) => c.path === '/api/nots/nepse-data/market-open')).toHaveLength(1);
    expect(calls.filter((c) => c.path.startsWith('/api/nots/security/'))).toHaveLength(3);
  });

  it('sends the Salter authorization and the payload id the original algorithm produced', async () => {
    const { provider, calls } = setup(() => json(securityDetail()));
    await provider.getSecurityDetail(397);
    const call = calls.find((c) => c.path === '/api/nots/security/397')!;
    expect(call.init.method).toBe('POST');
    expect((call.init.headers as Record<string, string>).Authorization).toBe(`Salter ${'x'.repeat(245)}`);
    // dummyData[5] = 312; 312 + 5 + 2 * 12
    expect(JSON.parse(call.init.body as string)).toEqual({ id: 341 });
  });

  it('parses the market status', async () => {
    const { provider } = setup(() => json({}));
    expect(await provider.getMarketStatus()).toEqual({
      isOpen: false,
      rawStatus: 'CLOSE',
      asOf: new Date('2024-06-12T09:15:00Z'),
      asOfDate: '2024-06-12',
    });
  });

  it('re-authenticates once when the token is rejected', async () => {
    let n = 0;
    const { provider, calls } = setup(() => (n++ === 0 ? json({}, 401) : json(securityDetail())));
    await provider.getSecurityDetail(397);
    expect(calls.filter((c) => c.path === '/api/authenticate/prove')).toHaveLength(2);
  });

  it('does not loop on persistent 401s', async () => {
    const { provider } = setup(() => json({}, 401));
    await expect(provider.getSecurityDetail(397)).rejects.toMatchObject({ kind: 'unauthorized' });
  });

  it('retries transient 5xx errors with backoff and then succeeds', async () => {
    let n = 0;
    const { provider, sleep } = setup(() => (n++ < 2 ? json({}, 502) : json(securityDetail())));
    await expect(provider.getSecurityDetail(397)).resolves.toBeDefined();
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('gives up after the configured number of retries', async () => {
    const { provider } = setup(() => json({}, 500));
    await expect(provider.getSecurityDetail(397)).rejects.toMatchObject({ kind: 'http', meta: { status: 500 } });
  });

  it('honours Retry-After on 429', async () => {
    let n = 0;
    const { provider, sleep } = setup(() => (n++ === 0 ? json({}, 429, { 'retry-after': '2' }) : json(securityDetail())));
    await provider.getSecurityDetail(397);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('fails fast when Retry-After exceeds the maximum delay', async () => {
    const { provider, sleep } = setup(() => json({}, 429, { 'retry-after': '3600' }));
    await expect(provider.getSecurityDetail(397)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not retry client errors', async () => {
    const { provider, calls } = setup(() => json({}, 404));
    await expect(provider.getSecurityDetail(397)).rejects.toMatchObject({ kind: 'http', meta: { status: 404 } });
    expect(calls.filter((c) => c.path === '/api/nots/security/397')).toHaveLength(1);
  });

  it('maps aborted requests to timeout errors', async () => {
    const { provider } = setup(() => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    });
    await expect(provider.getSecurityDetail(397)).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('reports non-JSON bodies as invalid responses without retrying', async () => {
    const { provider } = setup(() => new Response('<html>blocked</html>', { status: 200 }));
    const err = await provider.getSecurityDetail(397).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe('invalid_response');
    expect(err.message).not.toContain('blocked');
  });

  it('rejects a malformed prove response', async () => {
    const fetchImpl = vi.fn(async () => json({ accessToken: '' })) as unknown as typeof fetch;
    const provider = new NepseProvider({ baseUrl: 'https://nepse.test', timeoutMs: 1000, maxRetries: 0, retryBaseMs: 1, maxRetryDelayMs: 1, minIntervalMs: 0, sessionTtlMs: 1000, fetchImpl });
    await expect(provider.getMarketStatus()).rejects.toMatchObject({ kind: 'invalid_response' });
  });
});

describe('parseRetryAfter', () => {
  const now = new Date('2024-06-12T00:00:00Z');
  it('parses seconds and HTTP dates', () => {
    expect(parseRetryAfter('5', now)).toBe(5000);
    expect(parseRetryAfter('Wed, 12 Jun 2024 00:00:10 GMT', now)).toBe(10_000);
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });
});
