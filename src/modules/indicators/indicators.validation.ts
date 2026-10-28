import { z } from 'zod';
import { candleRangeShape } from '../market-data/market-data.validation.js';

const period = (def: number, min = 1) => z.coerce.number().int().min(min).max(500).default(def);

const fromBeforeTo = (q: { from?: string | undefined; to?: string | undefined }) => !q.from || !q.to || q.from <= q.to;

export const indicatorQuerySchema = z
  .discriminatedUnion('type', [
    z.object({ ...candleRangeShape, type: z.literal('sma'), period: period(20) }),
    z.object({ ...candleRangeShape, type: z.literal('ema'), period: period(20) }),
    z.object({ ...candleRangeShape, type: z.literal('rsi'), period: period(14, 2) }),
    z.object({
      ...candleRangeShape,
      type: z.literal('macd'),
      fast: period(12),
      slow: period(26, 2),
      signal: period(9),
    }),
  ])
  .refine(fromBeforeTo, { message: '`from` must not be after `to`', path: ['from'] })
  .refine((q) => q.type !== 'macd' || q.fast < q.slow, { message: '`fast` must be less than `slow`', path: ['fast'] });

export type IndicatorQuery = z.infer<typeof indicatorQuerySchema>;
