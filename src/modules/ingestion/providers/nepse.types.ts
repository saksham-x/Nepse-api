import { z } from 'zod';

/*
 * Runtime schemas for the three nepalstock.com.np endpoints the original code
 * used. Only fields this app reads are declared; everything else passes through
 * untouched. Most fields are optional so one missing field produces a reported
 * skip for that record rather than failing a whole sync.
 *
 * Field names for /api/nots/security/{id} could not be verified against a live
 * response while this was written (the endpoint refused connections from the
 * development environment). If NEPSE renames a field, records are skipped with
 * reason INVALID_RECORD and listed in the ingestion run details.
 */

// Zod 4 numbers reject NaN and ±Infinity by default.
const num = z.number();
const optNum = num.nullish();
const optStr = z.string().nullish();

/** GET /api/authenticate/prove */
export const proveResponseSchema = z.looseObject({
  accessToken: z.string().min(1),
  salt1: z.number().int(),
  salt2: z.number().int(),
  salt3: z.number().int(),
  salt4: z.number().int(),
  salt5: z.number().int(),
});
export type ProveResponse = z.infer<typeof proveResponseSchema>;

/** GET /api/nots/nepse-data/market-open */
export const marketOpenResponseSchema = z.looseObject({
  isOpen: z.string(),
  asOf: z.string(),
  id: z.number().int().min(0),
});
export type MarketOpenResponse = z.infer<typeof marketOpenResponseSchema>;

/** POST /api/nots/security/{id} */
export const securityDetailResponseSchema = z.looseObject({
  securityDailyTradeDto: z
    .looseObject({
      securityId: z.union([z.string(), num]).nullish(),
      businessDate: optStr,
      openPrice: optNum,
      highPrice: optNum,
      lowPrice: optNum,
      closePrice: optNum,
      lastTradedPrice: optNum,
      previousClose: optNum,
      totalTradeQuantity: optNum,
      totalTrades: optNum,
      fiftyTwoWeekHigh: optNum,
      fiftyTwoWeekLow: optNum,
      lastUpdatedDateTime: optStr,
    })
    .nullish(),
  security: z
    .looseObject({
      symbol: optStr,
      securityName: optStr,
      companyId: z
        .looseObject({
          companyName: optStr,
          sectorMaster: z.looseObject({ sectorDescription: optStr }).nullish(),
        })
        .nullish(),
      instrumentType: z.looseObject({ description: optStr }).nullish(),
    })
    .nullish(),
});
export type SecurityDetailResponse = z.infer<typeof securityDetailResponseSchema>;

/** Parsed market status, shared by every request in a provider session. */
export interface MarketStatus {
  isOpen: boolean;
  /** Raw provider value, e.g. 'OPEN' or 'CLOSE'. */
  rawStatus: string;
  asOf: Date | null;
  /** Trading date of `asOf` in Kathmandu, if parseable. */
  asOfDate: string | null;
}
