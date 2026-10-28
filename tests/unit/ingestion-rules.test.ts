import { describe, expect, it } from 'vitest';
import { checkCandle, diffCandles, type StoredCandle } from '../../src/modules/ingestion/ingestion.rules.js';
import type { NormalizedCandle } from '../../src/modules/ingestion/ingestion.types.js';

const today = '2024-06-12';
const ok = { tradeDate: '2024-06-10', open: 10, high: 12, low: 9, close: 11, volume: 100 };

describe('checkCandle', () => {
  it('accepts a consistent candle and rounds prices to 4 decimals', () => {
    expect(checkCandle({ ...ok, close: 11.123456 }, today)).toEqual({ ok: true, open: 10, high: 12, low: 9, close: 11.1235, volume: 100n });
  });

  it.each([
    [{ high: 10.5 }, 'OHLC_INCONSISTENT'], // high below close
    [{ low: 10.5 }, 'OHLC_INCONSISTENT'], // low above open
    [{ open: 0 }, 'INVALID_PRICES'],
    [{ close: null }, 'INVALID_PRICES'],
    [{ volume: -1 }, 'INVALID_VOLUME'],
    [{ volume: 1.5 }, 'INVALID_VOLUME'],
    [{ volume: undefined }, 'INVALID_VOLUME'],
    [{ tradeDate: '2024-02-30' }, 'INVALID_DATE'],
    [{ tradeDate: '2024-06-13' }, 'FUTURE_DATE'],
  ])('rejects %o with %s', (patch, reason) => {
    expect(checkCandle({ ...ok, ...patch }, today)).toMatchObject({ ok: false, reason });
  });

  it('accepts zero volume', () => {
    expect(checkCandle({ ...ok, volume: 0 }, today).ok).toBe(true);
  });
});

const candle = (tradeDate: string, overrides: Partial<NormalizedCandle> = {}): NormalizedCandle => ({
  instrumentId: 1,
  tradeDate,
  open: 10,
  high: 12,
  low: 9,
  close: 11,
  volume: 100n,
  trades: 5,
  isProvisional: false,
  source: 'NEPSE',
  ...overrides,
});
const stored = (c: NormalizedCandle): [string, StoredCandle] => [c.tradeDate, { ...c }];

describe('diffCandles', () => {
  it('inserts new candles', () => {
    const d = diffCandles(new Map(), [candle('2024-06-10'), candle('2024-06-11')], { overwrite: true });
    expect(d).toMatchObject({ inserted: 2, updated: 0, unchanged: 0 });
    expect(d.toWrite).toHaveLength(2);
  });

  it('writes nothing when the same data is ingested again', () => {
    const c = candle('2024-06-10');
    const d = diffCandles(new Map([stored(c)]), [c], { overwrite: true });
    expect(d).toMatchObject({ inserted: 0, updated: 0, unchanged: 1, toWrite: [] });
  });

  it('writes a corrected candle as an update', () => {
    const d = diffCandles(new Map([stored(candle('2024-06-10'))]), [candle('2024-06-10', { close: 11.5 })], { overwrite: true });
    expect(d).toMatchObject({ inserted: 0, updated: 1 });
    expect(d.toWrite[0]?.close).toBe(11.5);
  });

  it('finalizes a provisional candle', () => {
    const d = diffCandles(new Map([stored(candle('2024-06-10', { isProvisional: true }))]), [candle('2024-06-10')], { overwrite: true });
    expect(d.updated).toBe(1);
  });

  it('never replaces a final candle with a provisional one', () => {
    const d = diffCandles(new Map([stored(candle('2024-06-10'))]), [candle('2024-06-10', { isProvisional: true, close: 11.2 })], { overwrite: true });
    expect(d.toWrite).toEqual([]);
    expect(d.skipped[0]?.reason).toBe('PROVISIONAL_OVER_FINAL');
  });

  it('treats missing trades as "unknown", not as a change', () => {
    const d = diffCandles(new Map([stored(candle('2024-06-10'))]), [candle('2024-06-10', { trades: null })], { overwrite: true });
    expect(d.unchanged).toBe(1);
  });

  it('reports conflicts instead of overwriting when overwrite is off', () => {
    const d = diffCandles(new Map([stored(candle('2024-06-10'))]), [candle('2024-06-10', { close: 11.5 })], { overwrite: false });
    expect(d.toWrite).toEqual([]);
    expect(d.skipped[0]?.reason).toBe('CONFLICT_NOT_OVERWRITTEN');
  });
});
