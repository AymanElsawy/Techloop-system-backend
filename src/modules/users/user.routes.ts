import { Router } from 'express';
import * as userController from './user.controller.js';
import { authenticate } from '../../middleware/auth.middleware.js';
import { authorize } from '../../middleware/role.middleware.js';
import { UserRole } from './user.types.js';

export const userRoutes = Router();

userRoutes.use(authenticate, authorize(UserRole.OWNER, UserRole.ADMIN));

userRoutes.post('/', userController.create);
userRoutes.get('/', userController.list);
userRoutes.get('/targets', userController.targets);
userRoutes.get('/targets/:id', userController.repTargets);
userRoutes.get('/:id', userController.getById);
userRoutes.patch('/:id', userController.update);
userRoutes.patch('/:id/status', userController.updateStatus);
