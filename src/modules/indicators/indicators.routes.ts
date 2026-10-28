import { Router } from 'express';
import * as controller from './indicators.controller.js';

export const indicatorsRouter = Router();

indicatorsRouter.get('/:symbol', controller.getIndicator);
