import { Router } from 'express';
import * as collectionController from './collection.controller.js';
import { authenticate } from '../../middleware/auth.middleware.js';
import { authorize } from '../../middleware/role.middleware.js';
import { UserRole } from '../users/user.types.js';

export const collectionRoutes = Router();

collectionRoutes.use(authenticate);

collectionRoutes.get('/', collectionController.list);
collectionRoutes.post('/', collectionController.create);
collectionRoutes.get('/:id', collectionController.getById);
collectionRoutes.patch(
  '/:id/cancel',
  authorize(UserRole.OWNER, UserRole.ADMIN),
  collectionController.cancel,
);
collectionRoutes.post(
  '/:id/attachments',
  collectionController.collectionUpload.single,
  collectionController.uploadAttachment,
);
collectionRoutes.get('/:id/attachments/:attachmentId', collectionController.downloadAttachment);
