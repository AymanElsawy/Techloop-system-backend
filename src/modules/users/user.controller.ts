import type { Request, Response } from 'express';
import * as userService from './user.service.js';
import { repTargetReport, targetReport } from './targets.service.js';
import {
  createUserSchema,
  listUsersSchema,
  periodSchema,
  targetsQuerySchema,
  updateStatusSchema,
  updateUserSchema,
} from './user.validation.js';
import { ok } from '../../utils/api-response.js';
import { sendList, slicePage } from '../../utils/paginate.js';

type IdParams = { id: string };

export async function create(req: Request, res: Response) {
  const user = await userService.createUser(createUserSchema.parse(req.body));
  ok(res, user, 201);
}

export async function list(req: Request, res: Response) {
  const { search } = listUsersSchema.parse(req.query);
  await sendList(res, req.query, userService.listUsers(search));
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

/** With `?page=`: `reps` is one page and `meta.sum` the total commission of every matching rep. */
export async function targets(req: Request, res: Response) {
  const { search, ...period } = targetsQuerySchema.parse(req.query);
  const report = await targetReport(period);
  const q = search?.toLowerCase();
  const reps = q ? report.reps.filter((r) => r.name.toLowerCase().includes(q)) : report.reps;
  const page = slicePage(reps, req.query);
  if (!page) return ok(res, { ...report, reps });
  const sum = Math.round(reps.reduce((s, r) => s + r.commission, 0) * 100) / 100;
  ok(res, { ...report, reps: page.items }, 200, { ...page.meta, sum });
}

export async function repTargets(req: Request<IdParams>, res: Response) {
  ok(res, await repTargetReport(req.params.id, periodSchema.parse(req.query)));
}
