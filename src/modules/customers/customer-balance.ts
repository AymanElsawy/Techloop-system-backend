import type { Types } from 'mongoose';
import { CustomerModel } from './customer.model.js';
import { InvoiceModel } from '../invoices/invoice.model.js';
import { InvoiceStatus } from '../invoices/invoice.types.js';
import { CollectionModel } from '../collections/collection.model.js';
import { CollectionStatus } from '../collections/collection.types.js';
import { DepositStatus } from '../treasury/treasury.types.js';
import { ReturnModel, ReturnStatus } from '../returns/return.model.js';

const round2 = (n: number) => Math.round(n * 100) / 100;

const isPending = { $eq: ['$depositStatus', DepositStatus.PENDING] };

/**
 * Balance over active entries.
 * - net: invoice totals minus deposited payments (up-front on invoices, including any amount
 *   settling older debt, plus collections). Positive = customer owes.
 *   Active sales returns (فواتير مرتجع) reduce it too.
 * - pending: payments still in a rep's cash box; they reduce `net` only once handed over.
 */
export async function getCustomerBalance(customerId: Types.ObjectId) {
  const [[invoices], [collections], [returns]] = await Promise.all([
    InvoiceModel.aggregate<{ net: number; pending: number }>([
      { $match: { customer: customerId, status: InvoiceStatus.ACTIVE } },
      {
        $group: {
          _id: null,
          net: { $sum: { $subtract: ['$total', { $cond: [isPending, 0, '$paidAmount'] }] } },
          pending: { $sum: { $cond: [isPending, '$paidAmount', 0] } },
        },
      },
    ]),
    CollectionModel.aggregate<{ deposited: number; pending: number }>([
      { $match: { customer: customerId, status: CollectionStatus.ACTIVE } },
      {
        $group: {
          _id: null,
          deposited: { $sum: { $cond: [isPending, 0, '$amount'] } },
          pending: { $sum: { $cond: [isPending, '$amount', 0] } },
        },
      },
    ]),
    ReturnModel.aggregate<{ total: number }>([
      { $match: { customer: customerId, status: ReturnStatus.ACTIVE } },
      { $group: { _id: null, total: { $sum: '$total' } } },
    ]),
  ]);
  return {
    net: round2((invoices?.net ?? 0) - (collections?.deposited ?? 0) - (returns?.total ?? 0)),
    pending: round2((invoices?.pending ?? 0) + (collections?.pending ?? 0)),
  };
}

/** What can still be collected: the debt minus money already collected but not handed over. */
export async function getCollectableDebt(customerId: Types.ObjectId) {
  const { net, pending } = await getCustomerBalance(customerId);
  return Math.max(round2(net - pending), 0);
}

/**
 * Recomputes the customer's financial summary from active invoices and collections.
 * Recomputing (instead of incrementing) keeps it correct after cancellations and
 * self-heals if a previous write failed half-way.
 *
 * - debit (مدين): net amount the customer owes.
 * - credit (دائن): net amount owed to the customer (only after cancelling an already-paid invoice).
 * - pendingPayments: collected by a rep, not handed to the treasury yet (not deducted from debit).
 * - lastCollection: latest money received, up-front on an invoice or via a collection.
 */
export async function syncCustomerSummary(customerId: Types.ObjectId) {
  const [{ net, pending }, lastInvoice, lastPaidInvoice, lastCollection] = await Promise.all([
    getCustomerBalance(customerId),
    InvoiceModel.findOne({ customer: customerId, status: InvoiceStatus.ACTIVE }).sort({
      createdAt: -1,
    }),
    InvoiceModel.findOne({
      customer: customerId,
      status: InvoiceStatus.ACTIVE,
      paidAmount: { $gt: 0 },
    }).sort({
      createdAt: -1,
    }),
    CollectionModel.findOne({ customer: customerId, status: CollectionStatus.ACTIVE }).sort({
      createdAt: -1,
    }),
  ]);

  const payments = [
    lastPaidInvoice && { date: lastPaidInvoice.createdAt, amount: lastPaidInvoice.paidAmount },
    lastCollection && { date: lastCollection.createdAt, amount: lastCollection.amount },
  ].filter((p): p is { date: Date; amount: number } => !!p);
  const latestPayment = payments.sort((a, b) => b.date.getTime() - a.date.getTime())[0] ?? null;

  await CustomerModel.updateOne(
    { _id: customerId },
    {
      debit: Math.max(net, 0),
      credit: Math.max(-net, 0),
      pendingPayments: pending,
      lastInvoice: lastInvoice ? { date: lastInvoice.createdAt, amount: lastInvoice.total } : null,
      lastCollection: latestPayment,
    },
  );
}
