import { describe, expect, it } from 'vitest';
import { parseCsv, parseCsvDate, parseCsvNumber, resolveColumns } from '../../src/modules/ingestion/csv.js';

describe('parseCsv', () => {
  it('parses quoted fields, escaped quotes, CRLF and a BOM', () => {
    const text = '﻿Symbol,Date,Note\r\nNABIL,2024-06-10,"a, ""quoted"" note"\r\n\r\nHRL,2024-06-11,plain\n';
    const { header, rows } = parseCsv(text);
    expect(header).toEqual(['symbol', 'date', 'note']);
    expect(rows).toEqual([
      { line: 2, values: { symbol: 'NABIL', date: '2024-06-10', note: 'a, "quoted" note' } },
      { line: 4, values: { symbol: 'HRL', date: '2024-06-11', note: 'plain' } },
    ]);
  });
});

describe('resolveColumns', () => {
  it('accepts aliases and reports missing required columns', () => {
    expect(resolveColumns(['ticker', 'trade_date', 'open', 'high', 'low', 'ltp', 'qty'])).toMatchObject({ symbol: 'ticker', date: 'trade_date', close: 'ltp', volume: 'qty' });
    expect(() => resolveColumns(['symbol', 'date', 'open'])).toThrow(/high, low, close, volume/);
  });
});

describe('value parsing', () => {
  it('parses numbers with thousands separators and rejects junk', () => {
    expect(parseCsvNumber('1,234.50')).toBe(1234.5);
    expect(parseCsvNumber('')).toBeNull();
    expect(parseCsvNumber('12abc')).toBeNull();
  });

  it('accepts only unambiguous ISO dates', () => {
    expect(parseCsvDate('2024/06/10')).toBe('2024-06-10');
    expect(parseCsvDate('10/06/2024')).toBeNull();
    expect(parseCsvDate('2024-13-01')).toBeNull();
  });
});
