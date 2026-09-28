import { Types } from 'mongoose';
import { z } from 'zod';
import { ReturnModel, ReturnStatus } from './return.model.js';
import { InvoiceModel } from '../invoices/invoice.model.js';
import { InvoiceStatus } from '../invoices/invoice.types.js';
import { syncCustomerSummary } from '../customers/customer-balance.js';
import {
  cancelSaleReturn,
  findActiveWarehouse,
  receiveSaleReturn,
} from '../inventory/inventory.service.js';
import type { UserDocument } from '../users/user.model.js';
import { UserRole } from '../users/user.types.js';
import { AppError } from '../../utils/api-response.js';

const objectId = z.string().regex(/^[0-9a-f]{24}$/i, 'Invalid id');

export const createReturnSchema = z.object({
  invoiceId: objectId,
  warehouseId: objectId.nullish(), // managers only; defaults to the invoice's warehouse
  items: z
    .array(z.object({ productId: objectId, quantity: z.number().int().positive() }))
    .min(1)
    .refine(
      (items) => new Set(items.map((i) => i.productId)).size === items.length,
      'Duplicate product',
    ),
  notes: z.string().trim().max(1000).nullish(),
});
export const listReturnsSchema = z.object({
  customerId: objectId.optional(),
  invoiceId: objectId.optional(),
});
export const cancelReturnSchema = z.object({ reason: z.string().trim().min(3).max(500) });

const isManager = (actor: UserDocument) =>
  actor.role === UserRole.OWNER || actor.role === UserRole.ADMIN;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Reps only see (and return from) their own invoices. */
const visibility = (actor: UserDocument) => (isManager(actor) ? {} : { createdBy: actor._id });

const withRefs = [
  { path: 'customer', select: 'name governorate city phone' },
  { path: 'invoice', select: 'invoiceNumber createdAt' },
  { path: 'createdBy cancelledBy rep', select: 'name' },
  { path: 'warehouse', select: 'name' },
];

/** Quantity per product already returned (active returns) from an invoice. */
export async function returnedQuantities(invoiceId: Types.ObjectId) {
  const rows = await ReturnModel.aggregate<{ _id: Types.ObjectId; quantity: number }>([
    { $match: { invoice: invoiceId, status: ReturnStatus.ACTIVE } },
    { $unwind: '$items' },
    { $group: { _id: '$items.product', quantity: { $sum: '$items.quantity' } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.quantity]));
}

const stockItems = (items: { product: Types.ObjectId; name: string; quantity: number }[]) =>
  items.map((i) => ({ product: i.product, name: i.name, quantity: i.quantity }));

// ponytail: no transaction (standalone MongoDB), same as invoices. Stock goes in after the
// insert; the return is deleted again if that fails.
export async function createReturn(input: z.infer<typeof createReturnSchema>, actor: UserDocument) {
  const invoice = await InvoiceModel.findOne({ _id: input.invoiceId, ...visibility(actor) });
  if (!invoice) throw new AppError(404, 'Invoice not found');
  if (invoice.status !== InvoiceStatus.ACTIVE)
    throw new AppError(400, 'Cannot return from a cancelled invoice');

  const returned = await returnedQuantities(invoice._id);
  const sold = new Map(invoice.items.map((i) => [String(i.product), i]));
  const items = input.items.map(({ productId, quantity }) => {
    const line = sold.get(productId);
    if (!line) throw new AppError(400, 'Product is not on this invoice');
    const left = line.quantity - (returned.get(productId) ?? 0);
    if (quantity > left) throw new AppError(400, `Only ${left} of ${line.name} can be returned`);
    return {
      product: line.product,
      name: line.name,
      unit: line.unit,
      unitPrice: line.unitPrice,
      quantity,
      total: round2(line.unitPrice * quantity),
    };
  });

  // A rep's returns go to their custody; a manager picks the warehouse.
  const target = isManager(actor)
    ? {
        warehouse: input.warehouseId
          ? (await findActiveWarehouse(input.warehouseId))._id
          : invoice.warehouse,
        rep: null,
      }
    : { warehouse: actor.warehouse ?? invoice.warehouse, rep: actor._id };

  const last = await ReturnModel.findOne().sort({ number: -1 }).select('number');
  const doc = await ReturnModel.create({
    number: (last?.number ?? 0) + 1,
    invoice: invoice._id,
    customer: invoice.customer,
    createdBy: actor._id,
    ...target,
    items,
    total: round2(items.reduce((s, i) => s + i.total, 0)),
    notes: input.notes || null,
  });
  try {
    await receiveSaleReturn(stockItems(items), target, invoice._id, actor);
  } catch (err) {
    await doc.deleteOne();
    throw err;
  }
  await syncCustomerSummary(invoice.customer);
  return doc.populate(withRefs);
}

export function listReturns(
  { customerId, invoiceId }: z.infer<typeof listReturnsSchema>,
  actor: UserDocument,
) {
  return ReturnModel.find({
    ...visibility(actor),
    ...(customerId && { customer: customerId }),
    ...(invoiceId && { invoice: invoiceId }),
  })
    .sort({ createdAt: -1 })
    .populate(withRefs);
}

export async function getReturn(id: string, actor: UserDocument) {
  const doc = await ReturnModel.findOne({ _id: id, ...visibility(actor) }).populate(withRefs);
  if (!doc) throw new AppError(404, 'Return not found');
  return doc;
}

/** Takes the goods out of stock again; fails if they were already sold or moved on. */
export async function cancelReturn(id: string, reason: string, actor: UserDocument) {
  const doc = await ReturnModel.findById(id);
  if (!doc) throw new AppError(404, 'Return not found');
  if (doc.status === ReturnStatus.CANCELLED) throw new AppError(400, 'Return is already cancelled');

  await cancelSaleReturn(
    stockItems(doc.items),
    { warehouse: doc.warehouse, rep: doc.rep ?? null },
    doc.invoice,
    actor,
  );
  doc.set({
    status: ReturnStatus.CANCELLED,
    cancelReason: reason,
    cancelledBy: actor._id,
    cancelledAt: new Date(),
  });
  await doc.save();
  await syncCustomerSummary(doc.customer);
  return doc.populate(withRefs);
}
