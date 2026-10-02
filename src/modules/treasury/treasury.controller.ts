import type { Request, Response } from 'express';
import * as treasuryService from './treasury.service.js';
import {
  cancelEntrySchema,
  chequeStatusSchema,
  createDepositSchema,
  createEntrySchema,
  createRepExpenseSchema,
  listEntriesSchema,
  repFilterSchema,
} from './treasury.validation.js';
import { ok } from '../../utils/api-response.js';
import { UserRole } from '../users/user.types.js';

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

export async function listEntries(req: Request, res: Response) {
  ok(res, await treasuryService.listEntries(listEntriesSchema.parse(req.query), req.user!));
}

/** Managers: expense / withdrawal / bank deposit. A rep: an expense from their own cash box. */
export async function createEntry(req: Request, res: Response) {
  const actor = req.user!;
  const entry =
    actor.role === UserRole.SALES_REP
      ? await treasuryService.createRepExpense(createRepExpenseSchema.parse(req.body), actor)
      : await treasuryService.createEntry(createEntrySchema.parse(req.body), actor);
  ok(res, entry, 201);
}

export async function cashBox(req: Request, res: Response) {
  ok(res, await treasuryService.cashBoxOf(req.user!._id));
}

export async function cancelEntry(req: Request<{ id: string }>, res: Response) {
  const { reason } = cancelEntrySchema.parse(req.body);
  ok(res, await treasuryService.cancelEntry(req.params.id, reason, req.user!));
}

export async function listCheques(_req: Request, res: Response) {
  ok(res, await treasuryService.listCheques());
}

export async function setChequeStatus(req: Request<{ id: string }>, res: Response) {
  const { kind, status } = chequeStatusSchema.parse(req.body);
  ok(res, await treasuryService.setChequeStatus(req.params.id, kind, status, req.user!));
}
