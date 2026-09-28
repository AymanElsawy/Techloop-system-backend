import type { Request, Response } from 'express';
import * as customerService from './customer.service.js';
import {
  createCustomerSchema,
  listCustomersSchema,
  rejectCustomerSchema,
  updateCustomerSchema,
} from './customer.validation.js';
import { ok } from '../../utils/api-response.js';

type IdParams = { id: string };

export async function create(req: Request, res: Response) {
  const customer = await customerService.createCustomer(
    createCustomerSchema.parse(req.body),
    req.user!,
  );
  ok(res, customer, 201);
}

export async function list(req: Request, res: Response) {
  ok(res, await customerService.listCustomers(listCustomersSchema.parse(req.query), req.user!));
}

export async function getById(req: Request<IdParams>, res: Response) {
  ok(res, await customerService.getCustomerById(req.params.id, req.user!));
}

export async function update(req: Request<IdParams>, res: Response) {
  const input = updateCustomerSchema.parse(req.body);
  ok(res, await customerService.updateCustomer(req.params.id, input, req.user!));
}

export async function approve(req: Request<IdParams>, res: Response) {
  ok(res, await customerService.approveCustomer(req.params.id, req.user!));
}

export async function reject(req: Request<IdParams>, res: Response) {
  const { reason } = rejectCustomerSchema.parse(req.body);
  ok(res, await customerService.rejectCustomer(req.params.id, reason, req.user!));
}
