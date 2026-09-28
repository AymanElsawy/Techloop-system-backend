import type { Request, Response } from 'express';
import * as supplierService from './supplier.service.js';
import {
  createSupplierSchema,
  listSuppliersSchema,
  updateSupplierSchema,
} from './supplier.validation.js';
import { ok } from '../../utils/api-response.js';

type IdParams = { id: string };

export async function list(req: Request, res: Response) {
  ok(res, await supplierService.listSuppliers(listSuppliersSchema.parse(req.query)));
}

export async function create(req: Request, res: Response) {
  ok(res, await supplierService.createSupplier(createSupplierSchema.parse(req.body)), 201);
}

export async function getById(req: Request<IdParams>, res: Response) {
  ok(res, await supplierService.getSupplier(req.params.id));
}

export async function update(req: Request<IdParams>, res: Response) {
  const input = updateSupplierSchema.parse(req.body);
  ok(res, await supplierService.updateSupplier(req.params.id, input));
}
