import type { RequestHandler } from 'express';
import { AppError, ErrorCode } from '../errors/app-error.js';

export const notFound: RequestHandler = (req, _res, next) => {
  next(AppError.notFound(ErrorCode.ROUTE_NOT_FOUND, `No route for ${req.method} ${req.path}`));
};
