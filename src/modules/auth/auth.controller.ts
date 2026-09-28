import type { Request, Response } from 'express';
import * as authService from './auth.service.js';
import { loginSchema } from './auth.validation.js';
import { ok } from '../../utils/api-response.js';

export async function login(req: Request, res: Response) {
  ok(res, await authService.login(loginSchema.parse(req.body)));
}

export function me(req: Request, res: Response) {
  const { id, name, email, role, governorates } = req.user!;
  ok(res, { id, name, email, role, governorates });
}
