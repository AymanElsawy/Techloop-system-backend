import type { Request, Response } from 'express';
import * as authService from './auth.service.js';
import { changePasswordSchema, loginSchema } from './auth.validation.js';
import { ok } from '../../utils/api-response.js';

export async function login(req: Request, res: Response) {
  ok(res, await authService.login(loginSchema.parse(req.body)));
}

export function me(req: Request, res: Response) {
  ok(res, authService.sessionUser(req.user!));
}

export async function changePassword(req: Request, res: Response) {
  const { password } = changePasswordSchema.parse(req.body);
  ok(res, await authService.changePassword(req.user!, password));
}
