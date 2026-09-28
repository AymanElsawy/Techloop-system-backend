import type { Request, Response } from 'express';
import * as userService from './user.service.js';
import { createUserSchema, updateStatusSchema, updateUserSchema } from './user.validation.js';
import { ok } from '../../utils/api-response.js';

type IdParams = { id: string };

export async function create(req: Request, res: Response) {
  const user = await userService.createUser(createUserSchema.parse(req.body));
  ok(res, user, 201);
}

export async function list(_req: Request, res: Response) {
  ok(res, await userService.listUsers());
}

export async function getById(req: Request<IdParams>, res: Response) {
  ok(res, await userService.getUserById(req.params.id));
}

export async function update(req: Request<IdParams>, res: Response) {
  const input = updateUserSchema.parse(req.body);
  ok(res, await userService.updateUser(req.params.id, input, req.user!));
}

export async function updateStatus(req: Request<IdParams>, res: Response) {
  const { isActive } = updateStatusSchema.parse(req.body);
  ok(res, await userService.setUserStatus(req.params.id, isActive, req.user!));
}
