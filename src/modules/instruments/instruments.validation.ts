import { z } from 'zod';

/** NEPSE symbols are upper-case and may contain digits and '/', e.g. 'NICD83/84'. */
export const symbolSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9/&.-]{1,20}$/, 'symbol must be 1-20 characters of A-Z, 0-9, / & . -');

export const symbolParamsSchema = z.object({ symbol: symbolSchema });

export const searchQuerySchema = z.object({
  search: z.string().trim().max(50).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
