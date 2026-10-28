import { z } from 'zod';
import { isValidTradeDate } from '../../common/utils/time.js';
import { INTERVALS } from './market-data.types.js';

export const tradeDateSchema = z.string().refine(isValidTradeDate, 'must be a valid date in YYYY-MM-DD format');

/**
 * Range parameters shared by candles and indicators.
 * - `from` and `to` are inclusive trading dates.
 * - `before` is an exclusive upper bound; use the `nextBefore` value from the
 *   previous response to page backwards without gaps or duplicates.
 * - The page holds the newest `limit` candles in the range, ascending.
 */
export const candleRangeShape = {
  interval: z.enum(INTERVALS).default('1d'),
  from: tradeDateSchema.optional(),
  to: tradeDateSchema.optional(),
  before: tradeDateSchema.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(300),
};

const fromBeforeTo = (q: { from?: string | undefined; to?: string | undefined }) => !q.from || !q.to || q.from <= q.to;
const fromBeforeToIssue = { message: '`from` must not be after `to`', path: ['from'] };

export const candleRangeSchema = z.object(candleRangeShape).refine(fromBeforeTo, fromBeforeToIssue);
export type CandleRangeQuery = z.infer<typeof candleRangeSchema>;

export const candlesQuerySchema = z
  .object({ ...candleRangeShape, format: z.enum(['ohlcv', 'line']).default('ohlcv') })
  .refine(fromBeforeTo, fromBeforeToIssue);
