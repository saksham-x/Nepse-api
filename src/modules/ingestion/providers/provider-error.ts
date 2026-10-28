export type ProviderErrorKind =
  | 'timeout'
  | 'network'
  | 'rate_limited'
  | 'unauthorized'
  | 'http'
  | 'invalid_response';

/**
 * Failure talking to an upstream data provider. Messages are diagnostic and
 * never contain tokens or response bodies; they are logged, not sent to clients.
 */
export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly meta: { path?: string; status?: number; retryAfterMs?: number } = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ProviderError';
  }

  get retryable(): boolean {
    return this.kind === 'timeout' || this.kind === 'network' || this.kind === 'rate_limited' ||
      (this.kind === 'http' && (this.meta.status ?? 0) >= 500);
  }

  /** True when the provider could not be reached or is refusing service. */
  get isUnavailable(): boolean {
    return this.kind !== 'invalid_response';
  }
}
