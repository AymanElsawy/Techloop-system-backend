import type { Request, Response } from 'express';
import * as treasuryService from './treasury.service.js';
import { createDepositSchema, repFilterSchema } from './treasury.validation.js';
import { ok } from '../../utils/api-response.js';

export async function summary(_req: Request, res: Response) {
  ok(res, await treasuryService.getSummary());
}

export async function pending(req: Request, res: Response) {
  const { repId } = repFilterSchema.parse(req.query);
  ok(res, await treasuryService.listPending(repId, req.user!));
}

export async function listDeposits(req: Request, res: Response) {
  const { repId } = repFilterSchema.parse(req.query);
  ok(res, await treasuryService.listDeposits(repId, req.user!));
}

export async function getDeposit(req: Request<{ id: string }>, res: Response) {
  ok(res, await treasuryService.getDeposit(req.params.id, req.user!));
}

export async function createDeposit(req: Request, res: Response) {
  const input = createDepositSchema.parse(req.body);
  ok(res, await treasuryService.createDeposit(input, req.user!), 201);
}
