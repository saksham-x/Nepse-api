import type { Instrument } from '@prisma/client';
import type { Logger } from '../../config/logger.js';
import { forEachLimit } from '../../common/utils/concurrency.js';
import { createPollLoop } from '../../common/utils/poll-loop.js';
import { ProviderError } from '../ingestion/providers/provider-error.js';
import type { MarketStatus } from '../ingestion/providers/nepse.types.js';
import type { LiveSnapshot, MarketStatusDto } from './realtime.types.js';

export interface LiveFeedDeps {
  /** Instruments that currently have at least one subscriber. */
  targets: () => Instrument[];
  /** Fetches one instrument from the provider and stores it (throws ProviderError). */
  refresh: (instrument: Instrument) => Promise<void>;
  snapshot: (instrument: Instrument) => Promise<LiveSnapshot>;
  marketStatus: () => Promise<MarketStatus>;
  publishSnapshot: (snapshot: LiveSnapshot) => void;
  publishMarket: (status: MarketStatusDto) => void;
  logger: Logger;
  now: () => Date;
  config: {
    openIntervalMs: number;
    closedIntervalMs: number;
    concurrency: number;
  };
}

export const toMarketStatusDto = (s: MarketStatus): MarketStatusDto => ({
  isOpen: s.isOpen,
  rawStatus: s.rawStatus,
  asOf: s.asOf?.toISOString() ?? null,
  asOfDate: s.asOfDate,
});

/** Identifies the market data in a snapshot; `fetchedAt` changes on every poll, so it is left out. */
function fingerprint(s: LiveSnapshot): string {
  const { fetchedAt: _fetchedAt, ...quote } = s.quote ?? { fetchedAt: null };
  return JSON.stringify([quote, s.candle]);
}

/**
 * Polls the provider for subscribed instruments only, faster while the market
 * is open, and publishes a snapshot whenever its market data changes. Every
 * refresh is also stored, so REST reads see the same data.
 */
export function createLiveFeed(deps: LiveFeedDeps) {
  const log = deps.logger.child({ module: 'live-feed' });
  const lastPublished = new Map<string, string>();
  let lastMarket: MarketStatusDto | null = null;

  function publishIfChanged(snapshot: LiveSnapshot): void {
    const key = fingerprint(snapshot);
    if (lastPublished.get(snapshot.symbol) === key) return;
    lastPublished.set(snapshot.symbol, key);
    deps.publishSnapshot(snapshot);
  }

  async function poll(instrument: Instrument): Promise<void> {
    try {
      await deps.refresh(instrument);
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      log.warn({ symbol: instrument.symbol, kind: err.kind, message: err.message }, 'live refresh failed');
      return;
    }
    publishIfChanged(await deps.snapshot(instrument));
  }

  /** One pass over all targets; returns the delay before the next pass. */
  async function tick(): Promise<number> {
    const targets = deps.targets();
    const tracked = new Set(targets.map((t) => t.symbol));
    for (const symbol of lastPublished.keys()) if (!tracked.has(symbol)) lastPublished.delete(symbol);
    if (targets.length === 0) return deps.config.openIntervalMs;

    let isOpen = false;
    try {
      const status = toMarketStatusDto(await deps.marketStatus());
      isOpen = status.isOpen;
      if (JSON.stringify(status) !== JSON.stringify(lastMarket)) {
        lastMarket = status;
        deps.publishMarket(status);
      }
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      log.warn({ kind: err.kind, message: err.message }, 'live feed could not read market status');
    }

    await forEachLimit(targets, deps.config.concurrency, poll, loop.stopRequested);
    return isOpen ? deps.config.openIntervalMs : deps.config.closedIntervalMs;
  }

  const loop = createPollLoop(tick, (err) => {
    log.error({ err }, 'live feed tick failed');
    return deps.config.openIntervalMs;
  });

  return {
    start: loop.start,
    stop: loop.stop,

    /** Latest market status seen by the feed, if any. */
    marketStatus: (): MarketStatusDto | null => lastMarket,

    /**
     * Refreshes a newly subscribed instrument right away instead of waiting for
     * the next pass, unless its stored quote is already fresh.
     */
    async refreshNow(instrument: Instrument, current: LiveSnapshot): Promise<void> {
      lastPublished.set(instrument.symbol, fingerprint(current));
      const fetchedAt = current.quote ? Date.parse(current.quote.fetchedAt) : 0;
      if (deps.now().getTime() - fetchedAt < deps.config.openIntervalMs) return;
      await poll(instrument);
    },

    /** Exposed for tests. */
    tick,
  };
}

export type LiveFeed = ReturnType<typeof createLiveFeed>;
