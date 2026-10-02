import { Router } from 'express';
import { authRoutes } from '../modules/auth/auth.routes.js';
import { userRoutes } from '../modules/users/user.routes.js';
import { customerRoutes } from '../modules/customers/customer.routes.js';
import { productRoutes } from '../modules/products/product.routes.js';
import { invoiceRoutes } from '../modules/invoices/invoice.routes.js';
import { collectionRoutes } from '../modules/collections/collection.routes.js';
import { visitRoutes } from '../modules/visits/visit.routes.js';
import { inventoryRoutes } from '../modules/inventory/inventory.routes.js';
import { treasuryRoutes } from '../modules/treasury/treasury.routes.js';
import { supplierRoutes } from '../modules/suppliers/supplier.routes.js';
import { dashboardRoutes } from '../modules/dashboard/dashboard.routes.js';
import { documentRoutes } from '../modules/documents/documents.routes.js';
import { settingsRoutes } from '../modules/settings/settings.routes.js';
import { returnRoutes } from '../modules/returns/return.routes.js';
import { notificationRoutes } from '../modules/notifications/notification.routes.js';
import { reportRoutes } from '../modules/reports/report.routes.js';
import { publicRoutes } from '../modules/public/statement.js';

export const routes = Router();

routes.use('/auth', authRoutes);
routes.use('/users', userRoutes);
routes.use('/customers', customerRoutes);
routes.use('/products', productRoutes);
routes.use('/invoices', invoiceRoutes);
routes.use('/collections', collectionRoutes);
routes.use('/visits', visitRoutes);
routes.use('/inventory', inventoryRoutes);
routes.use('/treasury', treasuryRoutes);
routes.use('/suppliers', supplierRoutes);
routes.use('/dashboard', dashboardRoutes);
routes.use('/documents', documentRoutes);
routes.use('/settings', settingsRoutes);
routes.use('/returns', returnRoutes);
routes.use('/notifications', notificationRoutes);
routes.use('/reports', reportRoutes);
// No login: public balance links (رابط المديونية).
routes.use('/public', publicRoutes);
// Next phases: /orders
