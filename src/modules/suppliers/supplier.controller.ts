import type { Request, Response } from 'express';
import * as supplierService from './supplier.service.js';
import * as supplierPaymentService from './supplier-payment.service.js';
import {
  createSupplierSchema,
  listSuppliersSchema,
  updateSupplierSchema,
} from './supplier.validation.js';
import {
  cancelSupplierPaymentSchema,
  createSupplierPaymentSchema,
} from './supplier-payment.validation.js';
import { ok } from '../../utils/api-response.js';
import { SupplierModel } from './supplier.model.js';
import { ensureShareToken } from '../public/statement.js';

type IdParams = { id: string };
type PaymentIdParams = { paymentId: string };

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

export async function createPayment(req: Request<IdParams>, res: Response) {
  const input = createSupplierPaymentSchema.parse(req.body);
  ok(res, await supplierPaymentService.createPayment(req.params.id, input, req.user!), 201);
}

export async function listPayments(req: Request<IdParams>, res: Response) {
  ok(res, await supplierPaymentService.listPayments(req.params.id));
}

export async function cancelPayment(req: Request<PaymentIdParams>, res: Response) {
  const { reason } = cancelSupplierPaymentSchema.parse(req.body);
  ok(res, await supplierPaymentService.cancelPayment(req.params.paymentId, reason, req.user!));
}

export async function shareLink(req: Request<IdParams>, res: Response) {
  const supplier = await supplierService.findSupplier(req.params.id);
  ok(res, await ensureShareToken(SupplierModel, supplier._id));
}
