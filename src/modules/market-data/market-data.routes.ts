import { Router } from 'express';
import * as controller from './market-data.controller.js';

export const marketDataRouter = Router();

marketDataRouter.get('/:symbol/quote', controller.getQuote);
marketDataRouter.get('/:symbol/candles', controller.getCandles);
