import { Router } from 'express';
import * as invoiceController from './invoice.controller.js';
import { authenticate } from '../../middleware/auth.middleware.js';
import { authorize } from '../../middleware/role.middleware.js';
import { UserRole } from '../users/user.types.js';

export const invoiceRoutes = Router();

invoiceRoutes.use(authenticate);

invoiceRoutes.get('/', invoiceController.list);
invoiceRoutes.post('/', invoiceController.create);
invoiceRoutes.get('/:id', invoiceController.getById);
invoiceRoutes.patch(
  '/:id/cancel',
  authorize(UserRole.OWNER, UserRole.ADMIN),
  invoiceController.cancel,
);
invoiceRoutes.post(
  '/:id/attachments',
  invoiceController.invoiceUpload.single,
  invoiceController.uploadAttachment,
);
invoiceRoutes.get('/:id/attachments/:attachmentId', invoiceController.downloadAttachment);
