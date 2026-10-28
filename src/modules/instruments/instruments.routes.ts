import { Router } from 'express';
import * as controller from './instruments.controller.js';

// Express 5 forwards rejected promises from handlers to the error middleware.
export const instrumentsRouter = Router();

instrumentsRouter.get('/', controller.list);
instrumentsRouter.get('/:symbol', controller.getOne);
