import { Router } from 'express';
import * as visitController from './visit.controller.js';
import { authenticate } from '../../middleware/auth.middleware.js';

export const visitRoutes = Router();

visitRoutes.use(authenticate);

visitRoutes.get('/', visitController.list);
visitRoutes.post('/', visitController.create);
visitRoutes.get('/:id', visitController.getById);
visitRoutes.post('/:id/start', visitController.start);
visitRoutes.post('/:id/complete', visitController.complete);
visitRoutes.post('/:id/cancel', visitController.cancel);
