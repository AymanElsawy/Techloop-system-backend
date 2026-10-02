import { Router } from 'express';
import * as inventoryController from './inventory.controller.js';
import { authenticate } from '../../middleware/auth.middleware.js';
import { authorize } from '../../middleware/role.middleware.js';
import { UserRole } from '../users/user.types.js';

export const inventoryRoutes = Router();

const managersOnly = authorize(UserRole.OWNER, UserRole.ADMIN);
// Warehouse rep: issues custody to sales reps and takes their returns back, nothing else.
const warehouseOps = authorize(UserRole.OWNER, UserRole.ADMIN, UserRole.WAREHOUSE_REP);

inventoryRoutes.use(authenticate);

inventoryRoutes.get('/my-stock', inventoryController.myStock);
inventoryRoutes.get('/movements', inventoryController.listMovements);
inventoryRoutes.get('/movements/:id', inventoryController.getMovement);

inventoryRoutes.get('/warehouses', warehouseOps, inventoryController.listWarehouses);
inventoryRoutes.post('/warehouses', managersOnly, inventoryController.createWarehouse);
inventoryRoutes.get('/warehouses/:id', warehouseOps, inventoryController.getWarehouse);
inventoryRoutes.patch('/warehouses/:id', managersOnly, inventoryController.updateWarehouse);
inventoryRoutes.post('/warehouses/:id/receive', managersOnly, inventoryController.receive);
inventoryRoutes.post('/warehouses/:id/issue', warehouseOps, inventoryController.issue);
inventoryRoutes.post('/warehouses/:id/return', warehouseOps, inventoryController.returnStock);
inventoryRoutes.post('/warehouses/:id/adjust', managersOnly, inventoryController.adjust);
inventoryRoutes.post('/warehouses/:id/transfer', managersOnly, inventoryController.transfer);
