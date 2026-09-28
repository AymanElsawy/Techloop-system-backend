import type { Request, Response } from 'express';
import * as visitService from './visit.service.js';
import {
  cancelVisitSchema,
  completeVisitSchema,
  createVisitSchema,
  listVisitsSchema,
  startVisitSchema,
} from './visit.validation.js';
import { ok } from '../../utils/api-response.js';

type IdParams = { id: string };

export async function create(req: Request, res: Response) {
  ok(res, await visitService.createVisit(createVisitSchema.parse(req.body), req.user!), 201);
}

export async function list(req: Request, res: Response) {
  ok(res, await visitService.listVisits(listVisitsSchema.parse(req.query), req.user!));
}

export async function getById(req: Request<IdParams>, res: Response) {
  ok(res, await visitService.getVisitById(req.params.id, req.user!));
}

export async function start(req: Request<IdParams>, res: Response) {
  ok(
    res,
    await visitService.startVisit(req.params.id, startVisitSchema.parse(req.body), req.user!),
  );
}

export async function complete(req: Request<IdParams>, res: Response) {
  ok(
    res,
    await visitService.completeVisit(req.params.id, completeVisitSchema.parse(req.body), req.user!),
  );
}

export async function cancel(req: Request<IdParams>, res: Response) {
  const { reason } = cancelVisitSchema.parse(req.body ?? {});
  ok(res, await visitService.cancelVisit(req.params.id, reason, req.user!));
}
