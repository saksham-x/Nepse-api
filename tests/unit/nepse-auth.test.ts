import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  generateAuthorizationKey,
  securityPayloadId,
  tokenCutPositions,
} from '../../src/modules/ingestion/providers/nepse.auth.js';
import { ProviderError } from '../../src/modules/ingestion/providers/provider-error.js';

type Fn = (a: number, b: number, c: number, d: number, e: number) => number;
// The original, unmodified algorithms.js is the oracle for the port.
const legacy = createRequire(import.meta.url)('../fixtures/legacy-algorithms.cjs') as Record<'cdx' | 'rdx' | 'bdx' | 'ndx' | 'mdx', Fn>;

interface Salts {
  accessToken: string;
  salt1: number;
  salt2: number;
  salt3: number;
  salt4: number;
  salt5: number;
}

/** Verbatim copy of generateNewToken from the original nepse.js. */
function legacyGenerateNewToken(e: Salts): string {
  const n1 = legacy.cdx(e.salt1, e.salt2, e.salt3, e.salt4, e.salt5);
  const n2 = legacy.rdx(e.salt1, e.salt2, e.salt4, e.salt3, e.salt5);
  const n3 = legacy.bdx(e.salt1, e.salt2, e.salt4, e.salt3, e.salt5);
  const n4 = legacy.ndx(e.salt1, e.salt2, e.salt4, e.salt3, e.salt5);
  const n5 = legacy.mdx(e.salt1, e.salt2, e.salt4, e.salt3, e.salt5);
  return e.accessToken.slice(0, n1) + e.accessToken.slice(n1 + 1, n2) + e.accessToken.slice(n2 + 1, n3) +
    e.accessToken.slice(n3 + 1, n4) + e.accessToken.slice(n4 + 1, n5) + e.accessToken.slice(n5 + 1);
}

const legacyDummyData = [
  147, 117, 239, 143, 157, 312, 161, 612, 512, 804, 411, 527, 170, 511, 421, 667, 764, 621, 301, 106,
  133, 793, 411, 511, 312, 423, 344, 346, 653, 758, 342, 222, 236, 811, 711, 611, 122, 447, 128, 199,
  183, 135, 489, 703, 800, 745, 152, 863, 134, 211, 142, 564, 375, 793, 212, 153, 138, 153, 648, 611,
  151, 649, 318, 143, 117, 756, 119, 141, 717, 113, 112, 146, 162, 660, 693, 261, 362, 354, 251, 641,
  157, 178, 631, 192, 734, 445, 192, 883, 187, 122, 591, 731, 852, 384, 565, 596, 451, 772, 624, 691,
];

// A deterministic 250-character token, like the real accessToken length.
const TOKEN = Array.from({ length: 250 }, (_, i) => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[(i * 7 + 3) % 62]).join('');

describe('tokenCutPositions (port of cdx/rdx/bdx/ndx/mdx)', () => {
  it('matches the original functions for every salt2 in 0..99999', () => {
    for (let s = 0; s < 100_000; s++) {
      const expected = [
        legacy.cdx(1, s, 3, 4, 5),
        legacy.rdx(1, s, 4, 3, 5),
        legacy.bdx(1, s, 4, 3, 5),
        legacy.ndx(1, s, 4, 3, 5),
        legacy.mdx(1, s, 4, 3, 5),
      ];
      const actual = tokenCutPositions(s);
      if (actual.some((v, i) => v !== expected[i])) {
        expect({ salt2: s, actual }).toEqual({ salt2: s, actual: expected });
      }
    }
  });

  it('only depends on salt2, as the original did', () => {
    expect(legacy.cdx(999, 456, 1, 2, 3)).toBe(legacy.cdx(0, 456, 0, 0, 0));
    expect(legacy.mdx(999, 456, 1, 2, 3)).toBe(legacy.mdx(0, 456, 0, 0, 0));
  });

  it('always yields strictly ascending positions', () => {
    for (let s = 0; s < 1000; s++) {
      const p = tokenCutPositions(s);
      for (let i = 1; i < p.length; i++) expect(p[i]).toBeGreaterThan(p[i - 1] as number);
    }
  });

  it('rejects negative or non-integer salts instead of producing garbage', () => {
    expect(() => tokenCutPositions(-1)).toThrow(ProviderError);
    expect(() => tokenCutPositions(1.5)).toThrow(ProviderError);
  });
});

describe('generateAuthorizationKey', () => {
  it('produces the same key as the original generateNewToken', () => {
    for (const salt2 of [0, 7, 42, 123, 999, 5555, 31337, 87654]) {
      const salts = { accessToken: TOKEN, salt1: 11, salt2, salt3: 33, salt4: 44, salt5: 55 };
      const key = generateAuthorizationKey(TOKEN, salts);
      expect(key).toBe(legacyGenerateNewToken(salts));
      expect(key).toHaveLength(245);
    }
  });

  it('rejects a token too short to cut', () => {
    expect(() => generateAuthorizationKey('short', { salt1: 1, salt2: 1, salt3: 1, salt4: 1, salt5: 1 })).toThrow(/too short/);
  });
});

describe('securityPayloadId', () => {
  it('matches dummyData[id] + id + 2 * day from the original', () => {
    for (let id = 0; id < 100; id++) {
      for (const day of [1, 15, 31]) {
        expect(securityPayloadId(id, day)).toBe((legacyDummyData[id] as number) + id + 2 * day);
      }
    }
  });

  it('rejects ids outside the table (the original produced NaN)', () => {
    expect(() => securityPayloadId(100, 1)).toThrow(ProviderError);
    expect(() => securityPayloadId(-1, 1)).toThrow(ProviderError);
  });
});
