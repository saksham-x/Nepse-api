import { isValidTradeDate } from '../../common/utils/time.js';

export interface CsvRow {
  line: number;
  values: Record<string, string>;
}

/** Minimal RFC 4180 parser: quoted fields, escaped quotes, CRLF/LF line endings. */
export function parseCsv(text: string): { header: string[]; rows: CsvRow[] } {
  const records: { line: number; fields: string[] }[] = [];
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;

  const input = text.replace(/^﻿/, '');
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      fields.push(field);
      records.push({ line: recordLine, fields });
      fields = [];
      field = '';
      line++;
      recordLine = line;
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || fields.length > 0) {
    fields.push(field);
    records.push({ line: recordLine, fields });
  }

  const nonEmpty = records.filter((r) => r.fields.some((f) => f.trim() !== ''));
  const [head, ...body] = nonEmpty;
  const header = (head?.fields ?? []).map((h) => h.trim().toLowerCase());
  const rows = body.map((r) => ({
    line: r.line,
    values: Object.fromEntries(header.map((h, idx) => [h, (r.fields[idx] ?? '').trim()])),
  }));
  return { header, rows };
}

const COLUMN_ALIASES: Record<string, string[]> = {
  symbol: ['symbol', 'ticker'],
  date: ['date', 'trade_date', 'tradedate', 'business_date', 'businessdate'],
  open: ['open'],
  high: ['high'],
  low: ['low'],
  close: ['close', 'ltp'],
  volume: ['volume', 'qty', 'quantity', 'total_traded_quantity'],
  trades: ['trades', 'no_of_transactions', 'total_trades'],
};
const REQUIRED = ['symbol', 'date', 'open', 'high', 'low', 'close', 'volume'] as const;

/** Maps canonical column names to the header actually present in the file. */
export function resolveColumns(header: readonly string[]): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [canonical, aliases] of Object.entries(COLUMN_ALIASES)) {
    const found = aliases.find((a) => header.includes(a));
    if (found) resolved[canonical] = found;
  }
  const missing = REQUIRED.filter((c) => !resolved[c]);
  if (missing.length > 0) {
    throw new Error(`CSV is missing required column(s): ${missing.join(', ')}. Header: ${header.join(', ')}`);
  }
  return resolved;
}

/** Parses '1,234.50' style numbers. Empty or non-numeric input returns null. */
export function parseCsvNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const cleaned = value.replace(/,/g, '').trim();
  if (cleaned === '' || !/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  return Number(cleaned);
}

/** Accepts YYYY-MM-DD or YYYY/MM/DD. Anything else returns null (no locale guessing). */
export function parseCsvDate(value: string | undefined): string | null {
  const v = value?.trim().slice(0, 10).replace(/\//g, '-') ?? '';
  return isValidTradeDate(v) ? v : null;
}
