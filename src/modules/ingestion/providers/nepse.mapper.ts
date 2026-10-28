import { isValidTradeDate, parseKathmanduDateTime } from '../../../common/utils/time.js';
import { round } from '../../../common/utils/serialize.js';
import { checkCandle } from '../ingestion.rules.js';
import type { InstrumentPatch, NormalizedCandle, NormalizedQuote, SkippedRecord } from '../ingestion.types.js';
import { securityDetailResponseSchema, type MarketStatus } from './nepse.types.js';

export interface MapContext {
  instrumentId: number;
  symbol: string;
  marketStatus: MarketStatus;
  fetchedAt: Date;
  /** Current Kathmandu trading date. */
  today: string;
}

export interface MappedSecurity {
  candle: NormalizedCandle | null;
  quote: NormalizedQuote | null;
  patch: InstrumentPatch | null;
  skipped: SkippedRecord[];
}

const positive = (v: number | null | undefined): number | null =>
  typeof v === 'number' && v > 0 ? round(v, 4) : null;

const nonNegativeInt = (v: number | null | undefined): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;

const text = (v: string | null | undefined): string | undefined => {
  const t = v?.trim();
  return t ? t : undefined;
};

/** Normalizes one POST /api/nots/security/{id} response. Never throws on bad data. */
export function mapSecurityDetail(raw: unknown, ctx: MapContext): MappedSecurity {
  const skip = (reason: SkippedRecord['reason'], message: string, tradeDate?: string): MappedSecurity => ({
    candle: null,
    quote: null,
    patch: null,
    skipped: [{ symbol: ctx.symbol, tradeDate, reason, message }],
  });

  const parsed = securityDetailResponseSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return skip('INVALID_RECORD', `unexpected response shape at '${first?.path.join('.')}': ${first?.message}`);
  }

  const { security, securityDailyTradeDto: trade } = parsed.data;
  const providerSymbol = text(security?.symbol);
  if (providerSymbol && providerSymbol.toUpperCase() !== ctx.symbol) {
    return skip('SYMBOL_MISMATCH', `security id returned symbol ${providerSymbol}; the id map may be stale`);
  }
  if (!trade) return skip('INVALID_RECORD', 'response has no securityDailyTradeDto');

  const businessDate = trade.businessDate?.slice(0, 10) ?? '';
  if (!isValidTradeDate(businessDate)) return skip('INVALID_DATE', `invalid businessDate '${trade.businessDate}'`);

  const patch: InstrumentPatch = {
    instrumentId: ctx.instrumentId,
    name: text(security?.securityName) ?? text(security?.companyId?.companyName),
    sector: text(security?.companyId?.sectorMaster?.sectorDescription),
    instrumentType: text(security?.instrumentType?.description),
    lastSyncedAt: ctx.fetchedAt,
  };

  const skipped: SkippedRecord[] = [];

  const ltp = positive(trade.lastTradedPrice);
  const quote: NormalizedQuote | null = ltp === null
    ? null
    : {
        instrumentId: ctx.instrumentId,
        businessDate,
        lastTradedPrice: ltp,
        previousClose: positive(trade.previousClose),
        totalTradedQty: nonNegativeInt(trade.totalTradeQuantity) === null ? null : BigInt(trade.totalTradeQuantity as number),
        totalTrades: nonNegativeInt(trade.totalTrades),
        fiftyTwoWeekHigh: positive(trade.fiftyTwoWeekHigh),
        fiftyTwoWeekLow: positive(trade.fiftyTwoWeekLow),
        sourceUpdatedAt: trade.lastUpdatedDateTime ? parseKathmanduDateTime(trade.lastUpdatedDateTime) : null,
        marketOpen: ctx.marketStatus.isOpen,
        fetchedAt: ctx.fetchedAt,
      };
  if (!quote) {
    skipped.push({ symbol: ctx.symbol, tradeDate: businessDate, reason: 'INVALID_PRICES', message: 'no positive lastTradedPrice; quote not updated' });
  }

  // The session is still forming if the market was open and this record is for
  // the current session (not an older session of a security that hasn't traded yet).
  const sessionDate = ctx.marketStatus.asOfDate ?? ctx.today;
  const isProvisional = ctx.marketStatus.isOpen && businessDate >= sessionDate;

  let candle: NormalizedCandle | null = null;
  if (!positive(trade.openPrice) && !positive(trade.totalTradeQuantity)) {
    skipped.push({ symbol: ctx.symbol, tradeDate: businessDate, reason: 'NO_TRADES', message: 'no trades recorded for this session' });
  } else {
    // While a session is open the latest traded price is the provisional close.
    const close = isProvisional ? (positive(trade.lastTradedPrice) ?? trade.closePrice) : trade.closePrice;
    const check = checkCandle(
      {
        tradeDate: businessDate,
        open: trade.openPrice,
        high: trade.highPrice,
        low: trade.lowPrice,
        close,
        volume: trade.totalTradeQuantity,
      },
      ctx.today,
    );
    if (check.ok) {
      candle = {
        instrumentId: ctx.instrumentId,
        tradeDate: businessDate,
        open: check.open,
        high: check.high,
        low: check.low,
        close: check.close,
        volume: check.volume,
        trades: nonNegativeInt(trade.totalTrades),
        isProvisional,
        source: 'NEPSE',
      };
    } else {
      skipped.push({ symbol: ctx.symbol, tradeDate: businessDate, reason: check.reason, message: check.message });
    }
  }

  return { candle, quote, patch, skipped };
}
