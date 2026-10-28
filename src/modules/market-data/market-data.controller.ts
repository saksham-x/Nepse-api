import type { Request, Response } from 'express';
import { symbolParamsSchema } from '../instruments/instruments.validation.js';
import { candlesQuerySchema } from './market-data.validation.js';
import * as service from './market-data.service.js';

export async function getQuote(req: Request, res: Response): Promise<void> {
  const { symbol } = symbolParamsSchema.parse(req.params);
  res.json(await service.getQuote(symbol));
}

export async function getCandles(req: Request, res: Response): Promise<void> {
  const { symbol } = symbolParamsSchema.parse(req.params);
  const query = candlesQuerySchema.parse(req.query);
  res.json(await service.getCandles(symbol, query));
}
