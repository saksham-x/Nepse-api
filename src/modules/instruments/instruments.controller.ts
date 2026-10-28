import type { Request, Response } from 'express';
import { searchQuerySchema, symbolParamsSchema } from './instruments.validation.js';
import * as service from './instruments.service.js';

export async function list(req: Request, res: Response): Promise<void> {
  const query = searchQuerySchema.parse(req.query);
  const instruments = await service.searchInstruments(query.search, query.limit);
  res.json({ data: instruments, meta: { count: instruments.length } });
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const { symbol } = symbolParamsSchema.parse(req.params);
  res.json({ data: await service.getInstrumentDetails(symbol) });
}
