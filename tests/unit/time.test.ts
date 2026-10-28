import { describe, expect, it } from 'vitest';
import {
  addDays,
  dayOfWeek,
  isValidTradeDate,
  kathmanduDate,
  kathmanduDayOfMonth,
  parseKathmanduDateTime,
} from '../../src/common/utils/time.js';
import { bucketStart } from '../../src/modules/market-data/aggregation.js';

describe('Kathmandu calendar', () => {
  it('rolls over to the next date at 18:15 UTC (00:00 NPT)', () => {
    expect(kathmanduDate(new Date('2024-06-12T18:14:59Z'))).toBe('2024-06-12');
    expect(kathmanduDate(new Date('2024-06-12T18:15:00Z'))).toBe('2024-06-13');
    // A UTC server would have used day 12 here; NEPSE's calendar is already on the 13th.
    expect(kathmanduDayOfMonth(new Date('2024-06-12T20:00:00Z'))).toBe(13);
  });

  it('parses provider local times as UTC+05:45 and respects explicit offsets', () => {
    expect(parseKathmanduDateTime('2024-06-12T15:00:00')?.toISOString()).toBe('2024-06-12T09:15:00.000Z');
    expect(parseKathmanduDateTime('2024-06-12 11:00:00.123456789')?.toISOString()).toBe('2024-06-12T05:15:00.123Z');
    expect(parseKathmanduDateTime('2024-06-12T15:00:00Z')?.toISOString()).toBe('2024-06-12T15:00:00.000Z');
    expect(parseKathmanduDateTime('not a date')).toBeNull();
  });

  it('validates real calendar dates only', () => {
    expect(isValidTradeDate('2024-02-29')).toBe(true);
    expect(isValidTradeDate('2023-02-29')).toBe(false);
    expect(isValidTradeDate('2024-6-1')).toBe(false);
  });

  it('does calendar arithmetic without timezone drift', () => {
    expect(addDays('2024-12-31', 1)).toBe('2025-01-01');
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29');
    expect(dayOfWeek('2024-06-09')).toBe(0); // Sunday
  });

  it('buckets weeks from Sunday and months from the 1st', () => {
    expect(bucketStart('2024-06-13', '1w')).toBe('2024-06-09'); // Thursday -> Sunday
    expect(bucketStart('2024-06-09', '1w')).toBe('2024-06-09');
    expect(bucketStart('2024-06-15', '1w')).toBe('2024-06-09'); // Saturday stays in the same week
    expect(bucketStart('2024-06-13', '1mo')).toBe('2024-06-01');
    expect(bucketStart('2024-06-13', '1d')).toBe('2024-06-13');
  });
});
