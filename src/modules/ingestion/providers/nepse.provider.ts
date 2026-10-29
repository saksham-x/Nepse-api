import type { z } from 'zod';
import { env } from '../../../config/env.js';
import { logger as rootLogger, type Logger } from '../../../config/logger.js';
import { sleep as defaultSleep } from '../../../common/utils/concurrency.js';
import { kathmanduDate, kathmanduDayOfMonth, parseKathmanduDateTime } from '../../../common/utils/time.js';
import { generateAuthorizationKey, graphPayloadId, securityPayloadId } from './nepse.auth.js';
import { ProviderError } from './provider-error.js';
import {
  marketOpenResponseSchema,
  proveResponseSchema,
  type MarketStatus,
} from './nepse.types.js';

export interface NepseProviderOptions {
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  retryBaseMs: number;
  maxRetryDelayMs: number;
  minIntervalMs: number;
  sessionTtlMs: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  logger?: Logger;
}

interface Session {
  authorization: string;
  payloadId: number;
  graphPayloadId: number;
  marketStatus: MarketStatus;
  createdAt: number;
}

export const NEPSE_SOURCE = 'nepalstock.com.np';

/**
 * Client for the unofficial nepalstock.com.np web API:
 *
 *   GET  /api/authenticate/prove           -> accessToken + salts
 *   GET  /api/nots/nepse-data/market-open  -> market status + payload id seed
 *   POST /api/nots/security/{securityId}   -> security detail + daily trade snapshot
 *   GET  /api/nots/nepse-index             -> summary of every index
 *   POST /api/nots/graph/index/{indexId}   -> intraday index points (best effort)
 *
 * A "session" (Authorization header + payload id) is created once and reused
 * for `sessionTtlMs`, instead of re-authenticating for every symbol.
 */
export class NepseProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly log: Logger;
  private session: Session | null = null;
  private sessionPromise: Promise<Session> | null = null;
  private nextRequestAt = 0;

  constructor(private readonly options: NepseProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => new Date());
    this.log = (options.logger ?? rootLogger).child({ provider: 'nepse' });
  }

  /** Current market status (from the shared session; refreshed when the session expires). */
  async getMarketStatus(): Promise<MarketStatus> {
    return (await this.getSession()).marketStatus;
  }

  /** Raw security detail. Validation/mapping happens in nepse.mapper.ts. */
  getSecurityDetail(securityId: number): Promise<{ data: unknown; marketStatus: MarketStatus }> {
    return this.withSession((session) =>
      this.request(`/api/nots/security/${securityId}`, {
        method: 'POST',
        headers: { Authorization: session.authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: session.payloadId }),
      }),
    );
  }

  /** Raw summary of every NEPSE index (current value, change, day range). */
  getIndexSummary(): Promise<{ data: unknown; marketStatus: MarketStatus }> {
    return this.withSession((session) =>
      this.request('/api/nots/nepse-index', {
        headers: { Authorization: session.authorization, 'Content-Type': 'application/json' },
      }),
    );
  }

  /** Raw intraday points for one index (58 = NEPSE Index) for the current or last session. */
  getIndexGraph(indexId: number): Promise<{ data: unknown; marketStatus: MarketStatus }> {
    return this.withSession((session) =>
      this.request(`/api/nots/graph/index/${indexId}`, {
        method: 'POST',
        headers: { Authorization: session.authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: session.graphPayloadId }),
      }),
    );
  }

  /** Runs an authenticated request, re-authenticating once if the token is rejected. */
  private async withSession(fn: (session: Session) => Promise<unknown>): Promise<{ data: unknown; marketStatus: MarketStatus }> {
    for (let attempt = 0; ; attempt++) {
      const session = await this.getSession();
      try {
        const data = await fn(session);
        return { data, marketStatus: session.marketStatus };
      } catch (err) {
        // A rejected token usually means the session expired early: re-authenticate once.
        if (err instanceof ProviderError && err.kind === 'unauthorized' && attempt === 0) {
          this.invalidateSession(session);
          continue;
        }
        throw err;
      }
    }
  }

  invalidateSession(session?: Session): void {
    if (!session || this.session === session) this.session = null;
  }

  private async getSession(): Promise<Session> {
    if (this.session && this.now().getTime() - this.session.createdAt < this.options.sessionTtlMs) {
      return this.session;
    }
    // Concurrent callers share a single in-flight authentication.
    this.sessionPromise ??= this.createSession().finally(() => {
      this.sessionPromise = null;
    });
    return this.sessionPromise;
  }

  private async createSession(): Promise<Session> {
    const prove = this.parse(proveResponseSchema, await this.request('/api/authenticate/prove'), '/api/authenticate/prove');
    const authorization = `Salter ${generateAuthorizationKey(prove.accessToken, prove)}`;

    const marketRaw = await this.request('/api/nots/nepse-data/market-open', {
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
    });
    const market = this.parse(marketOpenResponseSchema, marketRaw, '/api/nots/nepse-data/market-open');

    const now = this.now();
    const asOf = parseKathmanduDateTime(market.asOf);
    const payloadId = securityPayloadId(market.id, kathmanduDayOfMonth(now));
    const session: Session = {
      authorization,
      payloadId,
      graphPayloadId: graphPayloadId(payloadId, prove, kathmanduDayOfMonth(now)),
      marketStatus: {
        isOpen: !/^close/i.test(market.isOpen.trim()),
        rawStatus: market.isOpen,
        asOf,
        asOfDate: asOf ? kathmanduDate(asOf) : null,
      },
      createdAt: now.getTime(),
    };
    this.session = session;
    this.log.debug({ marketStatus: session.marketStatus.rawStatus, asOf: market.asOf }, 'nepse session created');
    return session;
  }

  private parse<T extends z.ZodType>(schema: T, data: unknown, path: string): z.infer<T> {
    const result = schema.safeParse(data);
    if (!result.success) {
      const issue = result.error.issues[0];
      throw new ProviderError('invalid_response', `unexpected response from ${path} at '${issue?.path.join('.')}': ${issue?.message}`, { path });
    }
    return result.data;
  }

  /** One logical request with timeout, bounded retries, backoff and Retry-After handling. */
  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const url = new URL(path, this.options.baseUrl).toString();
    let lastError: ProviderError | undefined;

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      if (attempt > 0 && lastError) {
        const delay = lastError.meta.retryAfterMs ?? this.backoff(attempt);
        this.log.warn({ path, attempt, delayMs: delay, kind: lastError.kind, status: lastError.meta.status }, 'retrying provider request');
        await this.sleep(delay);
      }
      await this.throttle();

      try {
        return await this.attempt(url, path, init);
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        lastError = err;
        if (!err.retryable) throw err;
        if (err.meta.retryAfterMs !== undefined && err.meta.retryAfterMs > this.options.maxRetryDelayMs) {
          throw new ProviderError('rate_limited', `${path}: Retry-After of ${err.meta.retryAfterMs}ms exceeds the configured maximum`, err.meta);
        }
      }
    }
    throw lastError ?? new ProviderError('network', `${path}: request failed`, { path });
  }

  private async attempt(url: string, path: string, init: RequestInit): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        ...init,
        headers: { Accept: 'application/json', 'User-Agent': 'nepse-api/1.0', ...init.headers },
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (err) {
      const name = (err as Error)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new ProviderError('timeout', `${path}: timed out after ${this.options.timeoutMs}ms`, { path }, { cause: err });
      }
      throw new ProviderError('network', `${path}: ${(err as Error)?.message ?? 'network error'}`, { path }, { cause: err });
    }

    if (!res.ok) {
      // Drain the body so the connection can be reused; its content is not logged.
      await res.arrayBuffer().catch(() => undefined);
      const status = res.status;
      if (status === 401 || status === 403) throw new ProviderError('unauthorized', `${path}: HTTP ${status}`, { path, status });
      if (status === 429 || status === 503) {
        const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'), this.now());
        throw new ProviderError(status === 429 ? 'rate_limited' : 'http', `${path}: HTTP ${status}`, { path, status, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
      }
      throw new ProviderError('http', `${path}: HTTP ${status}`, { path, status });
    }

    try {
      return await res.json();
    } catch (err) {
      throw new ProviderError('invalid_response', `${path}: response is not valid JSON`, { path, status: res.status }, { cause: err });
    }
  }

  private backoff(attempt: number): number {
    const exp = this.options.retryBaseMs * 2 ** (attempt - 1);
    const jitter = Math.random() * this.options.retryBaseMs;
    return Math.min(exp + jitter, this.options.maxRetryDelayMs);
  }

  /** Spaces request starts at least `minIntervalMs` apart across all concurrent callers. */
  private async throttle(): Promise<void> {
    const now = Date.now();
    const startAt = Math.max(now, this.nextRequestAt);
    this.nextRequestAt = startAt + this.options.minIntervalMs;
    if (startAt > now) await this.sleep(startAt - now);
  }
}

/** Parses a Retry-After header (delta-seconds or HTTP-date) into milliseconds. */
export function parseRetryAfter(value: string | null, now: Date): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now.getTime());
}

let defaultProvider: NepseProvider | undefined;

export function getNepseProvider(): NepseProvider {
  defaultProvider ??= new NepseProvider({
    baseUrl: env.NEPSE_BASE_URL,
    timeoutMs: env.PROVIDER_TIMEOUT_MS,
    maxRetries: env.PROVIDER_MAX_RETRIES,
    retryBaseMs: env.PROVIDER_RETRY_BASE_MS,
    maxRetryDelayMs: env.PROVIDER_MAX_RETRY_DELAY_MS,
    minIntervalMs: env.PROVIDER_MIN_INTERVAL_MS,
    sessionTtlMs: env.PROVIDER_SESSION_TTL_MS,
  });
  return defaultProvider;
}
