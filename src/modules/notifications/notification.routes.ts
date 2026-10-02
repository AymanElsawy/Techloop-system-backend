import { Router } from 'express';
import { listNotifications, markAllRead, unreadCount } from './notification.service.js';
import { authenticate } from '../../middleware/auth.middleware.js';
import { ok } from '../../utils/api-response.js';

/** Every user only ever sees their own notifications. */
export const notificationRoutes = Router();

notificationRoutes.use(authenticate);

notificationRoutes.get('/', async (req, res) => {
  ok(res, await listNotifications(req.user!));
});
notificationRoutes.get('/unread-count', async (req, res) => {
  ok(res, { count: await unreadCount(req.user!) });
});
notificationRoutes.post('/read-all', async (req, res) => {
  await markAllRead(req.user!);
  ok(res, null);
});
