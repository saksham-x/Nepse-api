import type { Logger } from '../../config/logger.js';
import { createPollLoop } from '../../common/utils/poll-loop.js';
import { kathmanduDate } from '../../common/utils/time.js';
import { ProviderError } from '../ingestion/providers/provider-error.js';
import type { MarketStatus } from '../ingestion/providers/nepse.types.js';
import { mapIndexGraph, mapIndexSummary, mergePoints, NEPSE_INDEX_ID, type IndexPoint, type IndexSnapshot } from './index.mapper.js';

type ProviderCall = () => Promise<{ data: unknown; marketStatus: MarketStatus }>;

export interface IndexFeedDeps {
  getSummary: ProviderCall;
  getGraph: ProviderCall;
  /** Whether anyone is listening; the provider is not polled otherwise. */
  hasSubscribers: () => boolean;
  publish: (update: IndexUpdate) => void;
  logger: Logger;
  now: () => Date;
  config: {
    openIntervalMs: number;
    closedIntervalMs: number;
    /** Wait at least this long before retrying a failed intraday backfill. */
    graphRetryMs: number;
  };
}

export interface IndexUpdate {
  snapshot: IndexSnapshot;
  /** Point appended by this poll, if any. */
  point: IndexPoint | null;
}

export interface IndexState {
  snapshot: IndexSnapshot | null;
  /** Intraday points for the session of `snapshot`, ascending. */
  points: IndexPoint[];
}

/** A full session at a 5 s poll is ~3,000 points; this only guards against runaway growth. */
const MAX_POINTS = 10_000;

/**
 * Keeps the NEPSE Index and today's intraday series in memory. While someone is
 * subscribed it polls the index summary (every `openIntervalMs` while the market
 * is open), appends a point per poll and publishes the update. The intraday
 * graph endpoint is used, when it works, to fill in the session so far.
 */
export function createIndexFeed(deps: IndexFeedDeps) {
  const log = deps.logger.child({ module: 'index-feed' });
  let snapshot: IndexSnapshot | null = null;
  let points: IndexPoint[] = [];
  let sessionDate: string | null = null;
  let graphLoadedFor: string | null = null;
  let graphFailedAt = 0;
  let inFlight: Promise<number> | null = null;
  /** Whether the last poll succeeded; transitions are logged once instead of every poll. */
  let healthy = false;

  async function backfill(date: string): Promise<void> {
    if (graphLoadedFor === date || deps.now().getTime() - graphFailedAt < deps.config.graphRetryMs) return;
    try {
      const { data } = await deps.getGraph();
      const fetched = mapIndexGraph(data).filter((p) => kathmanduDate(new Date(p.time * 1000)) === date);
      if (fetched.length === 0) throw new ProviderError('invalid_response', 'intraday graph had no usable points for the session');
      // Polled points are newer than the graph's, so they win on equal times.
      points = mergePoints(fetched, points);
      graphLoadedFor = date;
      log.debug({ points: fetched.length }, 'intraday index backfilled');
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      graphFailedAt = deps.now().getTime();
      log.warn({ kind: err.kind, message: err.message }, 'intraday index graph unavailable; building the series from polls');
    }
  }

  async function poll(): Promise<number> {
    const fetchedAt = deps.now();
    let mapped: IndexSnapshot | null;
    let raw: unknown;
    try {
      const { data, marketStatus } = await deps.getSummary();
      raw = data;
      mapped = mapIndexSummary(data, marketStatus, fetchedAt);
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      log.warn({ kind: err.kind, message: err.message }, 'index summary fetch failed');
      healthy = false;
      return deps.config.openIntervalMs;
    }
    if (!mapped) {
      log.warn({ sample: JSON.stringify(raw)?.slice(0, 500) }, 'index summary had no usable NEPSE Index entry');
      healthy = false;
      return deps.config.openIntervalMs;
    }

    const date = kathmanduDate(new Date(mapped.asOf));
    if (date !== sessionDate) {
      sessionDate = date;
      points = [];
    }
    await backfill(date);

    // While closed the value doesn't move; only record it if the series is empty.
    let point: IndexPoint | null = null;
    const last = points[points.length - 1];
    if (mapped.marketOpen || !last) {
      const time = Math.max(Math.floor(fetchedAt.getTime() / 1000), (last?.time ?? 0) + 1);
      point = { time, value: mapped.value };
      points.push(point);
      if (points.length > MAX_POINTS) points = points.slice(-MAX_POINTS);
    }

    const changed = JSON.stringify({ ...snapshot, asOf: null }) !== JSON.stringify({ ...mapped, asOf: null });
    snapshot = mapped;
    if (!healthy) {
      healthy = true;
      log.info({ value: mapped.value, marketOpen: mapped.marketOpen, points: points.length }, 'NEPSE index feed is live');
    }
    if (point || changed) deps.publish({ snapshot: mapped, point });
    return mapped.marketOpen ? deps.config.openIntervalMs : deps.config.closedIntervalMs;
  }

  /** Polls now; concurrent callers share one request. */
  function refresh(): Promise<number> {
    inFlight ??= poll().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function tick(): Promise<number> {
    if (!deps.hasSubscribers()) return deps.config.openIntervalMs;
    return refresh();
  }

  const loop = createPollLoop(tick, (err) => {
    log.error({ err }, 'index feed tick failed');
    return deps.config.openIntervalMs;
  });

  return {
    start: loop.start,
    stop: loop.stop,
    tick,
    refresh,
    state: (): IndexState => ({ snapshot, points: [...points] }),
  };
}

export type IndexFeed = ReturnType<typeof createIndexFeed>;
