import type { Prisma } from '@prisma/client';

/**
 * API serialization policy:
 * - Prices are stored as DECIMAL(14,4) and returned as JSON numbers. Every value
 *   that fits DECIMAL(14,4) round-trips through a float64 to the same 4 decimals.
 * - Volumes are stored as BIGINT UNSIGNED and returned as JSON numbers. Values
 *   above Number.MAX_SAFE_INTEGER (~9e15 shares) are rejected rather than rounded.
 */
export function decimalToNumber(value: Prisma.Decimal): number;
export function decimalToNumber(value: Prisma.Decimal | null): number | null;
export function decimalToNumber(value: Prisma.Decimal | null): number | null {
  return value === null ? null : Number(value.toString());
}

export function bigintToNumber(value: bigint): number;
export function bigintToNumber(value: bigint | null): number | null;
export function bigintToNumber(value: bigint | null): number | null {
  if (value === null) return null;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`Integer ${value} exceeds the safe JSON range`);
  return Number(value);
}

/** Rounds to a fixed number of decimals for presentation. */
export function round(value: number, decimals = 4): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}
