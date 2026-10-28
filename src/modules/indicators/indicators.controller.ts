import type { Request, Response } from 'express';
import { symbolParamsSchema } from '../instruments/instruments.validation.js';
import { indicatorQuerySchema } from './indicators.validation.js';
import * as service from './indicators.service.js';

export async function getIndicator(req: Request, res: Response): Promise<void> {
  const { symbol } = symbolParamsSchema.parse(req.params);
  const query = indicatorQuerySchema.parse(req.query);
  res.json(await service.getIndicator(symbol, query));
}
