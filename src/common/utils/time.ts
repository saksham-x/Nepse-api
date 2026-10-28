/**
 * Date conventions used throughout the app:
 *
 * - A *trading date* is a calendar date on the NEPSE exchange calendar
 *   (Asia/Kathmandu), represented as a 'YYYY-MM-DD' string. It is not an instant.
 *   In MySQL it is a DATE column; Prisma surfaces it as a Date at 00:00 UTC.
 * - An *instant* (fetch time, provider update time) is a JS Date / ISO-8601 UTC string.
 *
 * Nepal has used a fixed UTC+05:45 offset with no daylight saving since 1986,
 * so converting provider local times with a fixed offset is exact.
 */

export const EXCHANGE_TIMEZONE = 'Asia/Kathmandu';
const KATHMANDU_OFFSET_MINUTES = 5 * 60 + 45;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidTradeDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
}

/** The current trading date in Kathmandu for a given instant. */
export function kathmanduDate(now: Date = new Date()): string {
  return new Date(now.getTime() + KATHMANDU_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);
}

/** Day of month (1-31) in Kathmandu for a given instant. */
export function kathmanduDayOfMonth(now: Date = new Date()): number {
  return Number(kathmanduDate(now).slice(8, 10));
}

/**
 * Parses a provider timestamp. Strings without an explicit offset
 * (e.g. '2024-06-12T15:00:00.123') are interpreted as Kathmandu local time.
 */
export function parseKathmanduDateTime(value: string): Date | null {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/.test(trimmed)) return null;
  const normalized = trimmed.replace(' ', 'T');
  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/.test(normalized);
  // JS Date accepts at most millisecond precision.
  const ms = normalized.replace(/(\.\d{3})\d+/, '$1');
  const d = new Date(hasOffset ? ms : `${ms}+05:45`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Converts a trading date to the Date Prisma expects for a DATE column. */
export function tradeDateToDb(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

/** Converts a Prisma DATE value back to a trading date string. */
export function tradeDateFromDb(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const d = tradeDateToDb(date);
  d.setUTCDate(d.getUTCDate() + days);
  return tradeDateFromDb(d);
}

/** 0 = Sunday ... 6 = Saturday, for a calendar date. */
export function dayOfWeek(date: string): number {
  return tradeDateToDb(date).getUTCDay();
}
