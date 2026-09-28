import type { Request, Response } from 'express';
import * as inventoryService from './inventory.service.js';
import {
  createWarehouseSchema,
  listMovementsSchema,
  receiveSchema,
  transferSchema,
  updateWarehouseSchema,
} from './inventory.validation.js';
import { ok } from '../../utils/api-response.js';

type IdParams = { id: string };

export async function listWarehouses(_req: Request, res: Response) {
  ok(res, await inventoryService.listWarehouses());
}

export async function createWarehouse(req: Request, res: Response) {
  ok(res, await inventoryService.createWarehouse(createWarehouseSchema.parse(req.body)), 201);
}

export async function getWarehouse(req: Request<IdParams>, res: Response) {
  ok(res, await inventoryService.getWarehouseDetails(req.params.id));
}

export async function updateWarehouse(req: Request<IdParams>, res: Response) {
  const input = updateWarehouseSchema.parse(req.body);
  ok(res, await inventoryService.updateWarehouse(req.params.id, input));
}

export async function receive(req: Request<IdParams>, res: Response) {
  const input = receiveSchema.parse(req.body);
  ok(res, await inventoryService.receiveStock(req.params.id, input, req.user!), 201);
}

export async function issue(req: Request<IdParams>, res: Response) {
  const input = transferSchema.parse(req.body);
  ok(res, await inventoryService.issueToRep(req.params.id, input, req.user!), 201);
}

export async function returnStock(req: Request<IdParams>, res: Response) {
  const input = transferSchema.parse(req.body);
  ok(res, await inventoryService.returnFromRep(req.params.id, input, req.user!), 201);
}

export async function listMovements(req: Request, res: Response) {
  const filters = listMovementsSchema.parse(req.query);
  ok(res, await inventoryService.listMovements(filters, req.user!));
}

export async function myStock(req: Request, res: Response) {
  ok(res, await inventoryService.getMyStock(req.user!));
}

export async function getMovement(req: Request<{ id: string }>, res: Response) {
  ok(res, await inventoryService.getMovement(req.params.id, req.user!));
}
