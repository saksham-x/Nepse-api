import type { Server as HttpServer } from 'node:http';
import type { Instrument } from '@prisma/client';
import { Server, type Socket } from 'socket.io';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { logger as rootLogger } from '../../config/logger.js';
import { AppError, ErrorCode } from '../../common/errors/app-error.js';
import { toAppError } from '../../common/middleware/error-handler.js';
import { getIngestionService } from '../ingestion/ingestion.service.js';
import { getNepseProvider } from '../ingestion/providers/nepse.provider.js';
import { indicatorQuerySchema } from '../indicators/indicators.validation.js';
import * as indicators from '../indicators/indicators.service.js';
import { requireInstrument } from '../instruments/instruments.service.js';
import { symbolSchema } from '../instruments/instruments.validation.js';
import * as marketData from '../market-data/market-data.service.js';
import { candlesQuerySchema } from '../market-data/market-data.validation.js';
import { createIndexFeed, type IndexFeed } from '../market-index/index-feed.js';
import { NEPSE_INDEX_ID } from '../market-index/index.mapper.js';
import { createLiveFeed, type LiveFeed } from './live-feed.js';
import type { ClientToServerEvents, ServerToClientEvents, SocketData, SocketErrorBody } from './realtime.types.js';

type IO = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type ClientSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

const ROOM_PREFIX = 'symbol:';
const INDEX_ROOM = 'index:NEPSE';
const room = (symbol: string) => `${ROOM_PREFIX}${symbol}`;

const symbolsSchema = z.object({ symbols: z.array(symbolSchema).min(1).max(env.LIVE_MAX_SYMBOLS_PER_CLIENT) });
const unsubscribeSchema = z.object({ symbols: z.array(symbolSchema).optional() }).default({});
const symbolPayload = z.looseObject({ symbol: symbolSchema });

/** Splits `{ symbol, ...query }` into the symbol and the remaining query fields. */
function splitSymbol(payload: unknown): { symbol: string; query: Record<string, unknown> } {
  const { symbol, ...query } = symbolPayload.parse(payload);
  return { symbol, query };
}

export interface Realtime {
  io: IO;
  feed: LiveFeed;
  indexFeed: IndexFeed;
  close(): Promise<void>;
}

/**
 * Socket.IO endpoint on the API's HTTP server (path `/socket.io`).
 *
 * - Live: `subscribe` / `unsubscribe` to symbols; the server pushes `snapshot`
 *   (quote + newest daily candle) when they change, and `market` on status changes.
 * - Historical: `candles:get`, `quote:get` and `indicators:get` take the same
 *   parameters as the REST endpoints and answer through the acknowledgement.
 */
export function attachRealtime(httpServer: HttpServer): Realtime {
  const log = rootLogger.child({ module: 'realtime' });
  const io: IO = new Server(httpServer, {
    cors: { origin: env.CORS_ORIGINS.includes('*') ? true : env.CORS_ORIGINS, methods: ['GET', 'POST'] },
    maxHttpBufferSize: 64 * 1024,
  });

  /** Instruments with at least one subscriber, by symbol. */
  const tracked = new Map<string, Instrument>();
  io.of('/').adapter.on('delete-room', (name: string) => {
    if (name.startsWith(ROOM_PREFIX)) tracked.delete(name.slice(ROOM_PREFIX.length));
  });

  const provider = getNepseProvider();
  const ingestion = getIngestionService();
  const feed = createLiveFeed({
    targets: () => [...tracked.values()],
    refresh: (inst) => ingestion.refreshInstrument(inst),
    snapshot: (inst) => marketData.getLiveSnapshot(inst),
    marketStatus: () => provider.getMarketStatus(),
    publishSnapshot: (s) => io.to(room(s.symbol)).emit('snapshot', s),
    publishMarket: (s) => io.emit('market', s),
    logger: rootLogger,
    now: () => new Date(),
    config: {
      openIntervalMs: env.LIVE_POLL_OPEN_SECONDS * 1000,
      closedIntervalMs: env.LIVE_POLL_CLOSED_SECONDS * 1000,
      concurrency: env.SYNC_CONCURRENCY,
    },
  });
  const indexFeed = createIndexFeed({
    getSummary: () => provider.getIndexSummary(),
    getGraph: () => provider.getIndexGraph(NEPSE_INDEX_ID),
    hasSubscribers: () => (io.of('/').adapter.rooms.get(INDEX_ROOM)?.size ?? 0) > 0,
    publish: (update) => io.to(INDEX_ROOM).emit('index', update),
    logger: rootLogger,
    now: () => new Date(),
    config: {
      openIntervalMs: env.LIVE_POLL_OPEN_SECONDS * 1000,
      closedIntervalMs: env.LIVE_POLL_CLOSED_SECONDS * 1000,
      graphRetryMs: 5 * 60_000,
    },
  });

  if (env.LIVE_FEED_ENABLED) {
    feed.start();
    indexFeed.start();
  }

  async function subscribe(socket: ClientSocket, payload: unknown) {
    const symbols = [...new Set(symbolsSchema.parse(payload).symbols)];
    const fresh = symbols.filter((s) => !socket.data.symbols.has(s));
    if (socket.data.symbols.size + fresh.length > env.LIVE_MAX_SYMBOLS_PER_CLIENT) {
      throw new AppError(429, ErrorCode.SUBSCRIPTION_LIMIT, `A connection can subscribe to at most ${env.LIVE_MAX_SYMBOLS_PER_CLIENT} symbols`);
    }

    const instruments = await Promise.all(symbols.map((s) => tracked.get(s) ?? requireInstrument(s)));
    const untracked = instruments.filter((i) => !tracked.has(i.symbol));
    if (tracked.size + untracked.length > env.LIVE_MAX_SYMBOLS) {
      throw new AppError(429, ErrorCode.SUBSCRIPTION_LIMIT, 'The server is tracking the maximum number of live symbols; try again later');
    }

    for (const inst of instruments) {
      tracked.set(inst.symbol, inst);
      socket.data.symbols.add(inst.symbol);
    }
    await socket.join(instruments.map((i) => room(i.symbol)));

    const snapshots = await Promise.all(instruments.map((i) => marketData.getLiveSnapshot(i)));
    if (env.LIVE_FEED_ENABLED) {
      instruments.forEach((inst, i) => {
        if (!untracked.includes(inst)) return;
        feed.refreshNow(inst, snapshots[i]!).catch((err) => log.error({ err, symbol: inst.symbol }, 'initial live refresh failed'));
      });
    }
    return { data: { subscribed: [...socket.data.symbols], snapshots, market: feed.marketStatus() } };
  }

  async function unsubscribe(socket: ClientSocket, payload: unknown) {
    const symbols = unsubscribeSchema.parse(payload ?? {}).symbols ?? [...socket.data.symbols];
    for (const s of symbols) {
      socket.data.symbols.delete(s);
      await socket.leave(room(s));
    }
    return { data: { subscribed: [...socket.data.symbols] } };
  }

  async function subscribeIndex(socket: ClientSocket) {
    await socket.join(INDEX_ROOM);
    const state = indexFeed.state();
    const age = state.snapshot ? Date.now() - Date.parse(state.snapshot.asOf) : Infinity;
    // A first or stale subscription polls right away; the result arrives as an `index` event.
    if (env.LIVE_FEED_ENABLED && age >= env.LIVE_POLL_OPEN_SECONDS * 1000) {
      indexFeed.refresh().catch((err) => log.error({ err }, 'index refresh failed'));
    }
    return { data: state };
  }

  io.on('connection', (socket) => {
    socket.data.symbols = new Set();
    const socketLog = log.child({ socketId: socket.id });
    socketLog.debug({ address: socket.handshake.address }, 'socket connected');

    // Fixed-window limit per connection, same budget as the REST API per client.
    let windowStart = Date.now();
    let used = 0;
    const allow = () => {
      const now = Date.now();
      if (now - windowStart >= env.API_RATE_LIMIT_WINDOW_MS) {
        windowStart = now;
        used = 0;
      }
      return ++used <= env.API_RATE_LIMIT_MAX;
    };

    const handle = (event: keyof ClientToServerEvents, fn: (payload: unknown) => Promise<{ data: unknown; meta?: unknown }>) => {
      // Socket.IO puts the ack callback last: `emit(event, cb)` without a payload makes it the first argument.
      socket.on(event, async (...args: unknown[]) => {
        const ack = args[args.length - 1];
        if (typeof ack !== 'function') return;
        const payload = args.length > 1 ? args[0] : undefined;
        if (!allow()) {
          ack({ ok: false, error: { code: ErrorCode.RATE_LIMITED, message: 'Too many requests, please slow down' } });
          return;
        }
        try {
          ack({ ok: true, ...(await fn(payload)) });
        } catch (err) {
          const appError = toAppError(err);
          if (appError.status >= 500) socketLog.error({ err, event, code: appError.code }, 'socket request failed');
          else socketLog.debug({ event, code: appError.code }, 'socket request rejected');
          const error: SocketErrorBody = { code: appError.code, message: appError.message, ...(appError.details ? { details: appError.details } : {}) };
          ack({ ok: false, error });
        }
      });
    };

    handle('subscribe', (p) => subscribe(socket, p));
    handle('unsubscribe', (p) => unsubscribe(socket, p));
    handle('candles:get', async (p) => {
      const { symbol, query } = splitSymbol(p);
      return marketData.getCandles(symbol, candlesQuerySchema.parse(query));
    });
    handle('quote:get', async (p) => marketData.getQuote(splitSymbol(p).symbol));
    handle('indicators:get', async (p) => {
      const { symbol, query } = splitSymbol(p);
      return indicators.getIndicator(symbol, indicatorQuerySchema.parse(query));
    });

    handle('index:subscribe', () => subscribeIndex(socket));
    handle('index:unsubscribe', async () => {
      await socket.leave(INDEX_ROOM);
      return { data: { subscribed: false } };
    });

    socket.on('disconnect', (reason) => socketLog.debug({ reason }, 'socket disconnected'));
  });

  return {
    io,
    feed,
    indexFeed,
    async close() {
      await Promise.all([feed.stop(), indexFeed.stop()]);
      io.disconnectSockets(true);
    },
  };
}
