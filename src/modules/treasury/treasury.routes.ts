import { Router } from 'express';
import * as treasuryController from './treasury.controller.js';
import { authenticate } from '../../middleware/auth.middleware.js';
import { authorize } from '../../middleware/role.middleware.js';
import { UserRole } from '../users/user.types.js';

export const treasuryRoutes = Router();

const managersOnly = authorize(UserRole.OWNER, UserRole.ADMIN);

treasuryRoutes.use(authenticate);

treasuryRoutes.get('/summary', managersOnly, treasuryController.summary);
treasuryRoutes.get('/pending', treasuryController.pending);
treasuryRoutes.get('/deposits', treasuryController.listDeposits);
treasuryRoutes.get('/deposits/:id', treasuryController.getDeposit);
treasuryRoutes.post('/deposits', managersOnly, treasuryController.createDeposit);
