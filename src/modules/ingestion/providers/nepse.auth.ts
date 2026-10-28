/**
 * Port of the original `algorithms.js` / `generateNewToken` / `dummyId` logic.
 *
 * The original cdx/rdx/bdx/ndx/mdx functions were decompiled WebAssembly. Every
 * one of them reads only its second argument, which is `salt2` at every call
 * site, and uses its units/tens/hundreds digits to index a lookup table (the
 * original `dataSegment`, read at 4-byte strides). This file computes the same
 * values directly; tests/unit/nepse-auth.test.ts checks equivalence against
 * the original code over a wide salt range.
 */

import { ProviderError } from './provider-error.js';

/** dataSegment[i * 4] from the original algorithms.js. */
const DIGIT_TABLE = [
  5, 8, 4, 7, 9, 4, 6, 9, 5, 5, 6, 5, 3, 5, 4, 4, 9, 6, 6, 8,
  8, 6, 8, 6, 5, 8, 4, 9, 5, 9, 8, 5, 3, 4, 7, 7, 4, 7, 3, 9,
] as const;

/** `dummyData` from the original nepse.js. Indexed by the market-open `id`. */
const PAYLOAD_TABLE = [
  147, 117, 239, 143, 157, 312, 161, 612, 512, 804,
  411, 527, 170, 511, 421, 667, 764, 621, 301, 106,
  133, 793, 411, 511, 312, 423, 344, 346, 653, 758,
  342, 222, 236, 811, 711, 611, 122, 447, 128, 199,
  183, 135, 489, 703, 800, 745, 152, 863, 134, 211,
  142, 564, 375, 793, 212, 153, 138, 153, 648, 611,
  151, 649, 318, 143, 117, 756, 119, 141, 717, 113,
  112, 146, 162, 660, 693, 261, 362, 354, 251, 641,
  157, 178, 631, 192, 734, 445, 192, 883, 187, 122,
  591, 731, 852, 384, 565, 596, 451, 772, 624, 691,
] as const;

export interface ProveSalts {
  salt1: number;
  salt2: number;
  salt3: number;
  salt4: number;
  salt5: number;
}

/** The five character positions removed from the access token, ascending. */
export function tokenCutPositions(salt2: number): [number, number, number, number, number] {
  if (!Number.isSafeInteger(salt2) || salt2 < 0) {
    throw new ProviderError('invalid_response', 'salt2 must be a non-negative integer');
  }
  const units = salt2 % 10;
  const tens = Math.floor(salt2 / 10) % 10;
  const hundreds = Math.floor(salt2 / 100) % 10;
  const lookup = DIGIT_TABLE[units + tens + hundreds] as number;

  return [
    lookup + 22, // cdx
    hundreds + tens + lookup + 32, // rdx
    hundreds + tens + lookup + 60, // bdx
    tens + lookup + 88, // ndx
    hundreds + lookup + 110, // mdx
  ];
}

/** Builds the value sent as `Authorization: Salter <key>`. */
export function generateAuthorizationKey(accessToken: string, salts: ProveSalts): string {
  const cuts = tokenCutPositions(salts.salt2);
  const last = cuts[4];
  if (accessToken.length <= last) {
    throw new ProviderError('invalid_response', `accessToken is too short (${accessToken.length} chars)`);
  }
  let key = '';
  let start = 0;
  for (const cut of cuts) {
    key += accessToken.slice(start, cut);
    start = cut + 1;
  }
  return key + accessToken.slice(start);
}

/**
 * Body id for POST /api/nots/security/{id}. `dayOfMonth` is the Kathmandu day
 * (the original used the host machine's local day; see README).
 */
export function securityPayloadId(marketOpenId: number, dayOfMonth: number): number {
  const base = PAYLOAD_TABLE[marketOpenId];
  if (!Number.isInteger(marketOpenId) || base === undefined) {
    throw new ProviderError('invalid_response', `market-open id ${marketOpenId} is outside the known table`);
  }
  if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) {
    throw new RangeError(`dayOfMonth must be 1-31, got ${dayOfMonth}`);
  }
  return base + marketOpenId + 2 * dayOfMonth;
}
