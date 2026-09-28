import { Router } from 'express';
import { getDashboard } from './dashboard.service.js';
import { authenticate } from '../../middleware/auth.middleware.js';
import { ok } from '../../utils/api-response.js';

export const dashboardRoutes = Router();

dashboardRoutes.get('/', authenticate, async (req, res) => {
  ok(res, await getDashboard(req.user!));
});
