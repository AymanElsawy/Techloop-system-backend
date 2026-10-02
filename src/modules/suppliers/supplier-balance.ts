import type { Types } from 'mongoose';
import { SupplierModel } from './supplier.model.js';
import { SupplierPaymentModel } from './supplier-payment.model.js';
import { SupplierPaymentStatus } from './supplier-payment.types.js';
import { MovementModel } from '../inventory/inventory.model.js';
import { MovementType } from '../inventory/inventory.types.js';
import { balanceEvents } from '../public/statement.js';

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * What the company still owes this supplier: unpaid balance left over receipts, minus
 * payments made since. Unlike customer debt, there's no rep-held "pending" money in between —
 * the admin pays the supplier directly, so this is a single running number.
 */
export async function getSupplierDebt(supplierId: Types.ObjectId) {
  const [[receipts], [payments]] = await Promise.all([
    MovementModel.aggregate<{ owed: number }>([
      { $match: { type: MovementType.RECEIVE, supplier: supplierId } },
      { $group: { _id: null, owed: { $sum: { $subtract: ['$totalCost', '$paidAmount'] } } } },
    ]),
    SupplierPaymentModel.aggregate<{ paid: number }>([
      { $match: { supplier: supplierId, status: SupplierPaymentStatus.ACTIVE } },
      { $group: { _id: null, paid: { $sum: '$amount' } } },
    ]),
  ]);
  return Math.max(round2((receipts?.owed ?? 0) - (payments?.paid ?? 0)), 0);
}

/** Recomputes (not increments) the supplier's cached debt, so it self-heals after cancellations. */
export async function syncSupplierDebt(supplierId: Types.ObjectId) {
  const debt = await getSupplierDebt(supplierId);
  await SupplierModel.updateOne({ _id: supplierId }, { debt });
  balanceEvents.emit('change', String(supplierId));
  return debt;
}
