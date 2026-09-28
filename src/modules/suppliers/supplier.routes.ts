import { Router } from 'express';
import * as supplierController from './supplier.controller.js';
import { authenticate } from '../../middleware/auth.middleware.js';
import { authorize } from '../../middleware/role.middleware.js';
import { UserRole } from '../users/user.types.js';

export const supplierRoutes = Router();

// Suppliers and purchase prices are management data.
supplierRoutes.use(authenticate, authorize(UserRole.OWNER, UserRole.ADMIN));

supplierRoutes.get('/', supplierController.list);
supplierRoutes.post('/', supplierController.create);
supplierRoutes.get('/:id', supplierController.getById);
supplierRoutes.patch('/:id', supplierController.update);
