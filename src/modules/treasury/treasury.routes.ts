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
// Reps: their own expenses only (the service scopes and limits them).
const withReps = authorize(UserRole.OWNER, UserRole.ADMIN, UserRole.SALES_REP);
treasuryRoutes.get('/cash-box', authorize(UserRole.SALES_REP), treasuryController.cashBox);
treasuryRoutes.get('/entries', withReps, treasuryController.listEntries);
treasuryRoutes.post('/entries', withReps, treasuryController.createEntry);
treasuryRoutes.patch('/entries/:id/cancel', withReps, treasuryController.cancelEntry);
treasuryRoutes.get('/cheques', managersOnly, treasuryController.listCheques);
treasuryRoutes.patch('/cheques/:id', managersOnly, treasuryController.setChequeStatus);
