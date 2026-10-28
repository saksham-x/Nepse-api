import { addDays, dayOfWeek } from '../../common/utils/time.js';
import type { Candle, DailyBar, Interval } from './market-data.types.js';

/**
 * Calendar start of the bucket containing `date`. Weeks start on Sunday, the
 * first NEPSE trading day of the week; months start on the 1st.
 */
export function bucketStart(date: string, interval: Interval): string {
  switch (interval) {
    case '1d':
      return date;
    case '1w':
      return addDays(date, -dayOfWeek(date));
    case '1mo':
      return `${date.slice(0, 7)}-01`;
  }
}

/** Upper bound on calendar days per bucket, used to size daily-row fetches. */
export const MAX_DAYS_PER_BUCKET: Record<Interval, number> = { '1d': 1, '1w': 7, '1mo': 31 };

/**
 * Aggregates ascending daily bars: first open, max high, min low, last close,
 * summed volume. A bucket is provisional if any of its sessions is.
 */
export function aggregate(bars: readonly DailyBar[], interval: Interval): Candle[] {
  if (interval === '1d') return [...bars];
  const out: Candle[] = [];
  for (const bar of bars) {
    const time = bucketStart(bar.time, interval);
    const last = out[out.length - 1];
    if (last && last.time === time) {
      last.high = Math.max(last.high, bar.high);
      last.low = Math.min(last.low, bar.low);
      last.close = bar.close;
      last.volume += bar.volume;
      last.provisional ||= bar.provisional;
    } else {
      out.push({ ...bar, time });
    }
  }
  return out;
}
