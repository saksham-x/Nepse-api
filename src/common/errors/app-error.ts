export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_JSON: 'INVALID_JSON',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  ROUTE_NOT_FOUND: 'ROUTE_NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  INSTRUMENT_NOT_FOUND: 'INSTRUMENT_NOT_FOUND',
  QUOTE_NOT_AVAILABLE: 'QUOTE_NOT_AVAILABLE',
  SUBSCRIPTION_LIMIT: 'SUBSCRIPTION_LIMIT',
  UPSTREAM_UNAVAILABLE: 'UPSTREAM_UNAVAILABLE',
  UPSTREAM_TIMEOUT: 'UPSTREAM_TIMEOUT',
  REFRESH_FAILED: 'REFRESH_FAILED',
  DATABASE_ERROR: 'DATABASE_ERROR',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  FORBIDDEN: 'FORBIDDEN',
  ADMIN_SESSION_REQUIRED: 'ADMIN_SESSION_REQUIRED',
  READ_ONLY: 'READ_ONLY',
  PORTFOLIO_SUSPENDED: 'PORTFOLIO_SUSPENDED',
  NOT_FOUND: 'NOT_FOUND',
  INVALID_STATE: 'INVALID_STATE',
  FILE_REJECTED: 'FILE_REJECTED',
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
