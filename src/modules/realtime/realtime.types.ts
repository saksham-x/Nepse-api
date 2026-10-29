import type { IndexState, IndexUpdate } from '../market-index/index-feed.js';
import type { Candle } from '../market-data/market-data.types.js';
import type { QuoteDto } from '../market-data/market-data.service.js';

/** Latest stored quote and newest daily candle (possibly provisional) for one symbol. */
export interface LiveSnapshot {
  symbol: string;
  quote: QuoteDto | null;
  candle: Candle | null;
}

export interface MarketStatusDto {
  isOpen: boolean;
  rawStatus: string;
  asOf: string | null;
  asOfDate: string | null;
}

/** Error shape sent in acknowledgements; same fields as the REST error body. */
export interface SocketErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type Ack<T> = (response: { ok: true; data: T; meta?: unknown } | { ok: false; error: SocketErrorBody }) => void;

/** Events the server sends. */
export interface ServerToClientEvents {
  snapshot: (snapshot: LiveSnapshot) => void;
  market: (status: MarketStatusDto) => void;
  index: (update: IndexUpdate) => void;
}

/** Events the client sends; every one takes an acknowledgement callback. */
export interface ClientToServerEvents {
  subscribe: (payload: unknown, ack: Ack<{ subscribed: string[]; snapshots: LiveSnapshot[]; market: MarketStatusDto | null }>) => void;
  unsubscribe: (payload: unknown, ack: Ack<{ subscribed: string[] }>) => void;
  'candles:get': (payload: unknown, ack: Ack<unknown>) => void;
  'quote:get': (payload: unknown, ack: Ack<unknown>) => void;
  'indicators:get': (payload: unknown, ack: Ack<unknown>) => void;
  'index:subscribe': (payload: unknown, ack: Ack<IndexState>) => void;
  'index:unsubscribe': (payload: unknown, ack: Ack<{ subscribed: false }>) => void;
}

export interface SocketData {
  symbols: Set<string>;
}
