import { Router } from 'express';
import { listAudit, listAuditSchema } from './audit.service.js';
import { authenticate } from '../../middleware/auth.middleware.js';
import { authorize } from '../../middleware/role.middleware.js';
import { sendList } from '../../utils/paginate.js';
import { UserRole } from '../users/user.types.js';

/** سجل العمليات: the owner only, read only. */
export const auditRoutes = Router();

auditRoutes.use(authenticate, authorize(UserRole.OWNER));

auditRoutes.get('/', async (req, res) => {
  await sendList(res, req.query, listAudit(listAuditSchema.parse(req.query)));
});
