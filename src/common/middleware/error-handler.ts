import type { ErrorRequestHandler } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { env } from '../../config/env.js';
import { AppError, ErrorCode } from '../errors/app-error.js';
import { ProviderError } from '../../modules/ingestion/providers/provider-error.js';

interface BodyParserError extends Error {
  type?: string;
  status?: number;
}

/** Translates any thrown value into the single public error shape. */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;

  if (err instanceof ZodError) {
    return new AppError(400, ErrorCode.VALIDATION_ERROR, 'Request validation failed', {
      issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }

  const bodyErr = err as BodyParserError;
  if (bodyErr?.type === 'entity.parse.failed') {
    return new AppError(400, ErrorCode.INVALID_JSON, 'Request body is not valid JSON');
  }
  if (bodyErr?.type === 'entity.too.large') {
    return new AppError(413, ErrorCode.PAYLOAD_TOO_LARGE, 'Request body is too large');
  }

  if (err instanceof ProviderError) {
    return err.kind === 'timeout'
      ? new AppError(504, ErrorCode.UPSTREAM_TIMEOUT, 'The market data provider timed out')
      : err.isUnavailable
        ? new AppError(503, ErrorCode.UPSTREAM_UNAVAILABLE, 'The market data provider is unavailable')
        : new AppError(502, ErrorCode.REFRESH_FAILED, 'The market data provider returned unusable data');
  }

  if (
    err instanceof Prisma.PrismaClientInitializationError ||
    err instanceof Prisma.PrismaClientKnownRequestError ||
    err instanceof Prisma.PrismaClientUnknownRequestError ||
    err instanceof Prisma.PrismaClientRustPanicError
  ) {
    const unreachable = err instanceof Prisma.PrismaClientInitializationError ||
      (err instanceof Prisma.PrismaClientKnownRequestError && ['P1001', 'P1002', 'P1008', 'P1017', 'P2024'].includes(err.code));
    return new AppError(unreachable ? 503 : 500, ErrorCode.DATABASE_ERROR, 'A database error occurred');
  }

  return new AppError(500, ErrorCode.INTERNAL_ERROR, 'An unexpected error occurred');
}

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  const appError = toAppError(err);
  const log = req.log ?? console;
  if (appError.status >= 500) {
    log.error({ err, code: appError.code }, 'request failed');
  } else {
    log.debug({ code: appError.code, message: (err as Error)?.message }, 'request rejected');
  }

  res.status(appError.status).json({
    error: {
      code: appError.code,
      message: appError.message,
      ...(appError.details ? { details: appError.details } : {}),
      requestId: req.id,
      ...(env.NODE_ENV === 'development' && err instanceof Error ? { stack: err.stack } : {}),
    },
  });
};
