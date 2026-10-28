import { describe, expect, it } from 'vitest';
import { ema } from '../../src/modules/indicators/calculations/ema.js';
import { macd } from '../../src/modules/indicators/calculations/macd.js';
import { rsi } from '../../src/modules/indicators/calculations/rsi.js';
import { sma } from '../../src/modules/indicators/calculations/sma.js';
import { computeIndicator, warmupBars } from '../../src/modules/indicators/indicators.service.js';
import { indicatorQuerySchema } from '../../src/modules/indicators/indicators.validation.js';

describe('sma', () => {
  it('averages each trailing window and leaves the warm-up null', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
    expect(sma([5], 1)).toEqual([5]);
  });

  it('returns all nulls when history is shorter than the period', () => {
    expect(sma([1, 2], 3)).toEqual([null, null]);
  });
});

describe('ema', () => {
  it('seeds with the SMA and applies k = 2 / (period + 1)', () => {
    // k = 0.5; seed = mean(1,2,3) = 2; then 4*.5+2*.5=3, 4, 5
    expect(ema([1, 2, 3, 4, 5, 6], 3)).toEqual([null, null, 2, 3, 4, 5]);
  });

  it('matches a hand-computed non-trivial series', () => {
    // period 2, k = 2/3: seed (10+12)/2 = 11; 14*2/3+11/3 = 13; 11*2/3+13/3 = 11.6667
    const out = ema([10, 12, 14, 11], 2);
    expect(out[1]).toBe(11);
    expect(out[2]).toBeCloseTo(13, 10);
    expect(out[3]).toBeCloseTo(35 / 3, 10);
  });

  it('skips leading nulls from an upstream series', () => {
    expect(ema([null, null, 2, 4, 6], 2)).toEqual([null, null, null, 3, 5]);
  });
});

describe('rsi (Wilder)', () => {
  it('matches hand-computed values', () => {
    // changes: +1, -1, +2, -1 ; period 2
    // i=2: avgG=.5 avgL=.5 -> 50
    // i=3: avgG=(.5+2)/2=1.25 avgL=(.5+0)/2=.25 -> 100-100/6
    // i=4: avgG=.625 avgL=.625 -> 50
    const out = rsi([10, 11, 10, 12, 11], 2);
    expect(out.slice(0, 2)).toEqual([null, null]);
    expect(out[2]).toBe(50);
    expect(out[3]).toBeCloseTo(100 - 100 / 6, 10);
    expect(out[4]).toBeCloseTo(50, 10);
  });

  it('is 100 with no losses and 50 when flat', () => {
    expect(rsi([1, 2, 3, 4], 2).slice(2)).toEqual([100, 100]);
    expect(rsi([5, 5, 5, 5], 2).slice(2)).toEqual([50, 50]);
  });

  it('needs period + 1 closes', () => {
    expect(rsi([1, 2, 3], 3)).toEqual([null, null, null]);
    expect(rsi([1, 2, 3, 4], 3)[3]).toBe(100);
  });

  it('stays within 0-100', () => {
    const closes = Array.from({ length: 300 }, (_, i) => 100 + 20 * Math.sin(i / 7) + (i % 5));
    for (const v of rsi(closes, 14)) if (v !== null) expect(v >= 0 && v <= 100).toBe(true);
  });
});

describe('macd', () => {
  const closes = Array.from({ length: 80 }, (_, i) => 100 + 10 * Math.sin(i / 5) + i * 0.3);

  it('is EMA(fast) - EMA(slow) with an EMA signal and histogram', () => {
    const out = macd(closes, 12, 26, 9);
    const f = ema(closes, 12);
    const s = ema(closes, 26);
    const line = closes.map((_, i) => (s[i] === null ? null : (f[i] as number) - (s[i] as number)));
    const sig = ema(line, 9);
    const firstIndex = 26 + 9 - 2;
    expect(out.findIndex((p) => p !== null)).toBe(firstIndex);
    for (let i = firstIndex; i < closes.length; i++) {
      expect(out[i]?.macd).toBeCloseTo(line[i] as number, 12);
      expect(out[i]?.signal).toBeCloseTo(sig[i] as number, 12);
      expect(out[i]?.histogram).toBeCloseTo((line[i] as number) - (sig[i] as number), 12);
    }
  });

  it('is zero for a constant series', () => {
    const out = macd(new Array(40).fill(50), 3, 6, 2);
    expect(out.filter(Boolean).every((p) => p!.macd === 0 && p!.signal === 0 && p!.histogram === 0)).toBe(true);
  });

  it('rejects fast >= slow', () => {
    expect(() => macd(closes, 26, 12, 9)).toThrow(RangeError);
  });
});

describe('indicator queries', () => {
  it('applies conventional defaults', () => {
    expect(indicatorQuerySchema.parse({ type: 'rsi' })).toMatchObject({ period: 14, interval: '1d', limit: 300 });
    expect(indicatorQuerySchema.parse({ type: 'macd' })).toMatchObject({ fast: 12, slow: 26, signal: 9 });
  });

  it('rejects unknown types and invalid MACD periods', () => {
    expect(indicatorQuerySchema.safeParse({ type: 'vwap' }).success).toBe(false);
    expect(indicatorQuerySchema.safeParse({ type: 'macd', fast: '30', slow: '26' }).success).toBe(false);
    expect(indicatorQuerySchema.safeParse({ type: 'sma', period: '0' }).success).toBe(false);
  });

  it('reports the documented warm-up length, matching the first defined value', () => {
    const closes = Array.from({ length: 100 }, (_, i) => 100 + Math.cos(i));
    for (const raw of [{ type: 'sma', period: '20' }, { type: 'ema', period: '10' }, { type: 'rsi' }, { type: 'macd' }]) {
      const q = indicatorQuerySchema.parse(raw);
      const values = computeIndicator(closes, q);
      expect(values.findIndex((v) => v !== null)).toBe(warmupBars(q));
    }
  });
});
