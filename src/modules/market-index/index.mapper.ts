import { round } from '../../common/utils/serialize.js';
import { parseKathmanduDateTime } from '../../common/utils/time.js';
import { indexSummaryItemSchema, indexSummaryResponseSchema, indexGraphResponseSchema, type MarketStatus } from '../ingestion/providers/nepse.types.js';

/** nepalstock.com.np id of the main NEPSE Index. */
export const NEPSE_INDEX_ID = 58;

export interface IndexSnapshot {
  name: string;
  value: number;
  previousClose: number | null;
  change: number | null;
  changePercent: number | null;
  high: number | null;
  low: number | null;
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
  /** Provider time of the value, or fetch time when the provider gives none (ISO-8601 UTC). */
  asOf: string;
  marketOpen: boolean;
}

/** One intraday point; `time` is a UNIX timestamp in seconds. */
export interface IndexPoint {
  time: number;
  value: number;
}

const positive = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
const finite = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Picks the NEPSE Index out of /api/nots/nepse-index. Returns null if it is missing or unusable. */
export function mapIndexSummary(data: unknown, marketStatus: MarketStatus, fetchedAt: Date): IndexSnapshot | null {
  const list = indexSummaryResponseSchema.safeParse(data);
  if (!list.success) return null;

  const items = list.data.flatMap((raw) => {
    const parsed = indexSummaryItemSchema.safeParse(raw);
    return parsed.success ? [parsed.data] : [];
  });
  const item = items.find((i) => i.id === NEPSE_INDEX_ID) ?? items.find((i) => /^nepse\s+index$/i.test(i.index.trim()));
  if (!item) return null;

  const value = positive(item.currentValue) ?? positive(item.close);
  if (value === null) return null;

  const previousClose = positive(item.previousClose);
  const change = finite(item.change) ?? (previousClose !== null ? round(value - previousClose, 2) : null);
  const changePercent = finite(item.perChange) ?? (change !== null && previousClose ? round((change / previousClose) * 100, 2) : null);
  const generated = item.generatedTime ? parseKathmanduDateTime(item.generatedTime) : null;

  return {
    name: item.index.trim(),
    value,
    previousClose,
    change,
    changePercent,
    high: positive(item.high),
    low: positive(item.low),
    fiftyTwoWeekHigh: positive(item.fiftyTwoWeekHigh),
    fiftyTwoWeekLow: positive(item.fiftyTwoWeekLow),
    asOf: (generated ?? fetchedAt).toISOString(),
    marketOpen: marketStatus.isOpen,
  };
}

/** Converts a [time, value] pair or {time|x, value|y} object to a point. Times in ms are scaled to s. */
function toPoint(raw: unknown): IndexPoint | null {
  let t: unknown;
  let v: unknown;
  if (Array.isArray(raw)) [t, v] = raw;
  else if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    t = o.time ?? o.x;
    v = o.value ?? o.y;
  }
  if (typeof t !== 'number' || typeof v !== 'number' || !Number.isFinite(t) || !(v > 0)) return null;
  return { time: Math.floor(t > 1e12 ? t / 1000 : t), value: v };
}

/** Intraday points from /api/nots/graph/index/{id}, ascending by time, one per second. */
export function mapIndexGraph(data: unknown): IndexPoint[] {
  const list = indexGraphResponseSchema.safeParse(data);
  if (!list.success) return [];
  return mergePoints([], list.data.flatMap((raw) => toPoint(raw) ?? []));
}

/** Union of two point lists, ascending; `incoming` wins on equal times. */
export function mergePoints(existing: readonly IndexPoint[], incoming: readonly IndexPoint[]): IndexPoint[] {
  const byTime = new Map<number, IndexPoint>();
  for (const p of existing) byTime.set(p.time, p);
  for (const p of incoming) byTime.set(p.time, p);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}
