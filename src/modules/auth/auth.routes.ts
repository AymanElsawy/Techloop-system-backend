import { Router } from 'express';
import * as authController from './auth.controller.js';
import { authenticate } from '../../middleware/auth.middleware.js';

export const authRoutes = Router();

authRoutes.post('/login', authController.login);
authRoutes.get('/me', authenticate, authController.me);
