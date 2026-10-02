import { Router } from 'express';
import * as customerController from './customer.controller.js';
import { authenticate } from '../../middleware/auth.middleware.js';
import { authorize } from '../../middleware/role.middleware.js';
import { UserRole } from '../users/user.types.js';

export const customerRoutes = Router();

customerRoutes.use(authenticate);

customerRoutes.get('/', customerController.list);
customerRoutes.post('/', customerController.create);
customerRoutes.get('/:id', customerController.getById);
customerRoutes.patch('/:id', customerController.update);
customerRoutes.post(
  '/:id/share-link',
  authorize(UserRole.OWNER, UserRole.ADMIN),
  customerController.shareLink,
);
customerRoutes.patch(
  '/:id/approve',
  authorize(UserRole.OWNER, UserRole.ADMIN),
  customerController.approve,
);
customerRoutes.patch(
  '/:id/reject',
  authorize(UserRole.OWNER, UserRole.ADMIN),
  customerController.reject,
);
