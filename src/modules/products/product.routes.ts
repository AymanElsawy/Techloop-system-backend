import { Router } from 'express';
import * as productController from './product.controller.js';
import { authenticate } from '../../middleware/auth.middleware.js';
import { authorize } from '../../middleware/role.middleware.js';
import { UserRole } from '../users/user.types.js';

export const productRoutes = Router();

const managersOnly = authorize(UserRole.OWNER, UserRole.ADMIN);

productRoutes.use(authenticate);

productRoutes.get('/', productController.list);
productRoutes.get('/:id', productController.getById);
productRoutes.post('/', managersOnly, productController.create);
productRoutes.patch('/:id', managersOnly, productController.update);
productRoutes.delete('/:id', managersOnly, productController.remove);
