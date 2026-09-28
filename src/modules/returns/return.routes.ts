import { Router, type Request } from 'express';
import * as returnService from './return.service.js';
import { authenticate } from '../../middleware/auth.middleware.js';
import { authorize } from '../../middleware/role.middleware.js';
import { ok } from '../../utils/api-response.js';
import { UserRole } from '../users/user.types.js';

export const returnRoutes = Router();

returnRoutes.use(authenticate);

returnRoutes.get('/', async (req, res) => {
  ok(
    res,
    await returnService.listReturns(returnService.listReturnsSchema.parse(req.query), req.user!),
  );
});
returnRoutes.post('/', async (req, res) => {
  ok(
    res,
    await returnService.createReturn(returnService.createReturnSchema.parse(req.body), req.user!),
    201,
  );
});
returnRoutes.get('/:id', async (req: Request<{ id: string }>, res) => {
  ok(res, await returnService.getReturn(req.params.id, req.user!));
});
returnRoutes.patch(
  '/:id/cancel',
  authorize(UserRole.OWNER, UserRole.ADMIN),
  async (req: Request<{ id: string }>, res) => {
    const { reason } = returnService.cancelReturnSchema.parse(req.body);
    ok(res, await returnService.cancelReturn(req.params.id, reason, req.user!));
  },
);
