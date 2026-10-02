import { Router } from 'express';
import * as authController from './auth.controller.js';
import { authenticateAllowingPasswordChange } from '../../middleware/auth.middleware.js';

export const authRoutes = Router();

authRoutes.post('/login', authController.login);
authRoutes.get('/me', authenticateAllowingPasswordChange, authController.me);
authRoutes.post('/change-password', authenticateAllowingPasswordChange, authController.changePassword);
