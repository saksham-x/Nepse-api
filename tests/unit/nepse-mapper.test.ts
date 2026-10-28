import { describe, expect, it } from 'vitest';
import { mapSecurityDetail, type MapContext } from '../../src/modules/ingestion/providers/nepse.mapper.js';
import { securityDetail } from '../fixtures/security-detail.js';

const closedCtx: MapContext = {
  instrumentId: 1,
  symbol: 'ADBL',
  marketStatus: { isOpen: false, rawStatus: 'CLOSE', asOf: new Date('2024-06-12T09:15:00Z'), asOfDate: '2024-06-12' },
  fetchedAt: new Date('2024-06-12T10:00:00Z'),
  today: '2024-06-12',
};
const openCtx: MapContext = { ...closedCtx, marketStatus: { ...closedCtx.marketStatus, isOpen: true, rawStatus: 'OPEN' } };

describe('mapSecurityDetail', () => {
  it('maps a complete response into a final candle, quote and instrument patch', () => {
    const out = mapSecurityDetail(securityDetail(), closedCtx);
    expect(out.skipped).toEqual([]);
    expect(out.candle).toEqual({
      instrumentId: 1,
      tradeDate: '2024-06-12',
      open: 300,
      high: 310.5,
      low: 298,
      close: 305.2,
      volume: 12_345n,
      trades: 210,
      isProvisional: false,
      source: 'NEPSE',
    });
    expect(out.quote).toMatchObject({
      businessDate: '2024-06-12',
      lastTradedPrice: 305.2,
      previousClose: 299,
      totalTradedQty: 12_345n,
      marketOpen: false,
      // 15:00:02.123 Kathmandu = 09:15:02.123 UTC
      sourceUpdatedAt: new Date('2024-06-12T09:15:02.123Z'),
    });
    expect(out.patch).toMatchObject({ name: 'Agricultural Development Bank Limited', sector: 'Commercial Banks', instrumentType: 'Equity' });
  });

  it('marks the current session provisional while the market is open and uses LTP as close', () => {
    const out = mapSecurityDetail(securityDetail({ trade: { closePrice: null, lastTradedPrice: 306, highPrice: 310.5 } }), openCtx);
    expect(out.candle).toMatchObject({ isProvisional: true, close: 306 });
  });

  it('treats an older session as final even while the market is open', () => {
    const out = mapSecurityDetail(securityDetail({ trade: { businessDate: '2024-06-11' } }), openCtx);
    expect(out.candle?.isProvisional).toBe(false);
  });

  it('skips the candle but keeps the quote when OHLC is inconsistent', () => {
    const out = mapSecurityDetail(securityDetail({ trade: { highPrice: 200 } }), closedCtx);
    expect(out.candle).toBeNull();
    expect(out.quote).not.toBeNull();
    expect(out.skipped).toEqual([expect.objectContaining({ reason: 'OHLC_INCONSISTENT', symbol: 'ADBL', tradeDate: '2024-06-12' })]);
  });

  it('skips a candle with missing prices rather than storing partial data', () => {
    const out = mapSecurityDetail(securityDetail({ trade: { lowPrice: null } }), closedCtx);
    expect(out.candle).toBeNull();
    expect(out.skipped[0]?.reason).toBe('INVALID_PRICES');
  });

  it('reports a session with no trades without treating it as an error', () => {
    const out = mapSecurityDetail(securityDetail({ trade: { openPrice: 0, totalTradeQuantity: 0, highPrice: 0, lowPrice: 0 } }), closedCtx);
    expect(out.candle).toBeNull();
    expect(out.skipped[0]?.reason).toBe('NO_TRADES');
  });

  it('rejects a response for a different symbol (stale id map)', () => {
    const out = mapSecurityDetail(securityDetail({ security: { symbol: 'NABIL' } }), closedCtx);
    expect(out).toMatchObject({ candle: null, quote: null, patch: null });
    expect(out.skipped[0]?.reason).toBe('SYMBOL_MISMATCH');
  });

  it('reports malformed payloads instead of throwing', () => {
    expect(mapSecurityDetail('<html>', closedCtx).skipped[0]?.reason).toBe('INVALID_RECORD');
    expect(mapSecurityDetail(securityDetail({ trade: null }), closedCtx).skipped[0]?.reason).toBe('INVALID_RECORD');
    expect(mapSecurityDetail(securityDetail({ trade: { openPrice: 'abc' } }), closedCtx).skipped[0]?.reason).toBe('INVALID_RECORD');
    expect(mapSecurityDetail(securityDetail({ trade: { businessDate: '12/06/2024' } }), closedCtx).skipped[0]?.reason).toBe('INVALID_DATE');
  });

  it('does not emit empty names that would blank stored values', () => {
    const out = mapSecurityDetail(securityDetail({ security: { securityName: '  ', companyId: null, instrumentType: null } }), closedCtx);
    expect(out.patch?.name).toBeUndefined();
    expect(out.patch?.sector).toBeUndefined();
  });

  it('rejects fractional volume', () => {
    const out = mapSecurityDetail(securityDetail({ trade: { totalTradeQuantity: 10.5 } }), closedCtx);
    expect(out.skipped[0]?.reason).toBe('INVALID_VOLUME');
  });
});
