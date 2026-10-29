import type { Instrument } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { logger } from '../../src/config/logger.js';
import { ProviderError } from '../../src/modules/ingestion/providers/provider-error.js';
import { createLiveFeed, type LiveFeedDeps } from '../../src/modules/realtime/live-feed.js';
import type { LiveSnapshot } from '../../src/modules/realtime/realtime.types.js';

const inst = (id: number, symbol: string) => ({ id, symbol, nepseSecurityId: id }) as Instrument;
const ADBL = inst(1, 'ADBL');
const NABIL = inst(2, 'NABIL');

const snap = (symbol: string, ltp: number, fetchedAt = '2024-06-12T05:00:00.000Z'): LiveSnapshot => ({
  symbol,
  quote: { symbol, lastTradedPrice: ltp, fetchedAt } as LiveSnapshot['quote'],
  candle: { time: '2024-06-12', open: 100, high: 110, low: 95, close: ltp, volume: 10, provisional: true },
});

function setup(overrides: Partial<LiveFeedDeps> = {}) {
  const prices = new Map([['ADBL', 100], ['NABIL', 500]]);
  let polls = 0;
  const deps: LiveFeedDeps = {
    targets: () => [ADBL, NABIL],
    refresh: vi.fn(async () => undefined),
    snapshot: vi.fn(async (i: Instrument) => snap(i.symbol, prices.get(i.symbol)!, `2024-06-12T05:00:0${polls++ % 10}.000Z`)),
    marketStatus: vi.fn(async () => ({ isOpen: true, rawStatus: 'OPEN', asOf: new Date('2024-06-12T05:00:00Z'), asOfDate: '2024-06-12' })),
    publishSnapshot: vi.fn(),
    publishMarket: vi.fn(),
    logger,
    now: () => new Date('2024-06-12T05:00:30Z'),
    config: { openIntervalMs: 15_000, closedIntervalMs: 300_000, concurrency: 2 },
    ...overrides,
  };
  return { deps, prices, feed: createLiveFeed(deps) };
}

describe('live feed', () => {
  it('publishes only snapshots whose market data changed', async () => {
    const { deps, prices, feed } = setup();
    expect(await feed.tick()).toBe(15_000);
    expect(deps.publishSnapshot).toHaveBeenCalledTimes(2);
    expect(deps.publishMarket).toHaveBeenCalledWith({ isOpen: true, rawStatus: 'OPEN', asOf: '2024-06-12T05:00:00.000Z', asOfDate: '2024-06-12' });

    // Only fetchedAt differs: nothing new to publish.
    await feed.tick();
    expect(deps.publishSnapshot).toHaveBeenCalledTimes(2);
    expect(deps.publishMarket).toHaveBeenCalledTimes(1);

    prices.set('NABIL', 505);
    await feed.tick();
    expect(deps.publishSnapshot).toHaveBeenCalledTimes(3);
    expect(vi.mocked(deps.publishSnapshot).mock.lastCall?.[0]).toMatchObject({ symbol: 'NABIL', quote: { lastTradedPrice: 505 } });
  });

  it('polls slowly while the market is closed and skips the provider when nobody listens', async () => {
    const closed = setup({ marketStatus: async () => ({ isOpen: false, rawStatus: 'CLOSE', asOf: null, asOfDate: null }) });
    expect(await closed.feed.tick()).toBe(300_000);

    const idle = setup({ targets: () => [] });
    await idle.feed.tick();
    expect(idle.deps.marketStatus).not.toHaveBeenCalled();
    expect(idle.deps.refresh).not.toHaveBeenCalled();
  });

  it('keeps going when one symbol fails upstream', async () => {
    const { deps, feed } = setup({
      refresh: vi.fn(async (i: Instrument) => {
        if (i.symbol === 'ADBL') throw new ProviderError('timeout', 'timed out');
      }),
    });
    await feed.tick();
    expect(deps.publishSnapshot).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.publishSnapshot).mock.lastCall?.[0].symbol).toBe('NABIL');
  });

  it('refreshes a new subscription immediately only when its quote is stale', async () => {
    const { deps, feed } = setup();
    await feed.refreshNow(ADBL, snap('ADBL', 100, '2024-06-12T05:00:20.000Z'));
    expect(deps.refresh).not.toHaveBeenCalled();

    await feed.refreshNow(NABIL, snap('NABIL', 499, '2024-06-12T04:00:00.000Z'));
    expect(deps.refresh).toHaveBeenCalledWith(NABIL);
    expect(deps.publishSnapshot).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'NABIL' }));
  });
});
