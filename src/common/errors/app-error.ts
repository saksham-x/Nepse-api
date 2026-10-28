export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_JSON: 'INVALID_JSON',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  ROUTE_NOT_FOUND: 'ROUTE_NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  INSTRUMENT_NOT_FOUND: 'INSTRUMENT_NOT_FOUND',
  QUOTE_NOT_AVAILABLE: 'QUOTE_NOT_AVAILABLE',
  UPSTREAM_UNAVAILABLE: 'UPSTREAM_UNAVAILABLE',
  UPSTREAM_TIMEOUT: 'UPSTREAM_TIMEOUT',
  REFRESH_FAILED: 'REFRESH_FAILED',
  DATABASE_ERROR: 'DATABASE_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** An error whose status, code and message are safe to return to API clients. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'AppError';
  }

  static notFound(code: ErrorCode, message: string, details?: Record<string, unknown>): AppError {
    return new AppError(404, code, message, details);
  }
}
