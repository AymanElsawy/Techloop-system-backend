import { Types } from 'mongoose';
import { InvoiceModel } from '../invoices/invoice.model.js';
import { InvoiceStatus } from '../invoices/invoice.types.js';
import { CollectionModel } from '../collections/collection.model.js';
import { CollectionStatus } from '../collections/collection.types.js';
import { ReturnModel, ReturnStatus } from '../returns/return.model.js';
import { CustomerModel } from '../customers/customer.model.js';
import { SupplierModel } from '../suppliers/supplier.model.js';
import { SupplierPaymentModel } from '../suppliers/supplier-payment.model.js';
import { SupplierPaymentStatus } from '../suppliers/supplier-payment.types.js';
import { MovementModel } from '../inventory/inventory.model.js';
import { MovementType } from '../inventory/inventory.types.js';
import { ChequeStatus, DepositStatus } from '../treasury/treasury.types.js';
import { getCustomerBalance } from '../customers/customer-balance.js';
import { getSupplierDebt } from '../suppliers/supplier-balance.js';
import { AppError } from '../../utils/api-response.js';
import { purchasesReport, salesReport } from './report.service.js';

const round2 = (n: number) => Math.round(n * 100) / 100;
const sum = <T>(list: T[], f: (x: T) => number) => round2(list.reduce((s, x) => s + f(x), 0));

/** One document in a customer / supplier report, oldest first. */
export type Line = {
  kind: 'invoice' | 'return' | 'collection' | 'receipt' | 'payment';
  id: string;
  number: string;
  date: Date;
  /** Customer: the sale. Supplier: the purchase. */
  debit: number;
  /** Customer: paid up front, collected, or returned. Supplier: what the company paid. */
  credit: number;
  method: string | null; // payment method; null on an invoice = deferred (آجل)
  /** A bounced cheque: listed, but not counted as paid. */
  bounced: boolean;
  /** Paid, but the money is still with the rep (already deducted from the balance). */
  pending: boolean;
  /** Running balance after this line, like كشف الحساب (customer: owes us; supplier: we owe). */
  balance: number;
};

/** Sorts oldest first and fills the running balance from `opening`; returns the closing balance. */
function runBalance(lines: Omit<Line, 'balance'>[], opening: number) {
  let balance = opening;
  const sorted = [...lines]
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .map((l) => {
      balance = round2(balance + l.debit - l.credit);
      return { ...l, balance };
    });
  return { lines: sorted, closing: balance };
}

// ---------- customers ----------

/** Paid up front on invoices + collections, per customer, without bounced cheques. */
async function collectedByCustomer(match: Record<string, unknown>) {
  const notBounced = { chequeStatus: { $ne: ChequeStatus.BOUNCED } };
  const group = (field: string) => ({ $group: { _id: '$customer', total: { $sum: field } } });
  const [invoices, collections] = await Promise.all([
    InvoiceModel.aggregate<{ _id: Types.ObjectId; total: number }>([
      { $match: { ...match, ...notBounced, status: InvoiceStatus.ACTIVE, paidAmount: { $gt: 0 } } },
      group('$paidAmount'),
    ]),
    CollectionModel.aggregate<{ _id: Types.ObjectId; total: number }>([
      { $match: { ...match, ...notBounced, status: CollectionStatus.ACTIVE } },
      group('$amount'),
    ]),
  ]);
  const totals = new Map<string, number>();
  for (const r of [...invoices, ...collections])
    totals.set(String(r._id), round2((totals.get(String(r._id)) ?? 0) + r.total));
  return totals;
}

/**
 * Every customer with sales, returns or payments in the period, or a balance now.
 * `balance` is today's (debit - credit): positive = the customer owes, negative = we owe them.
 */
export async function customersReport(from: Date, to: Date) {
  const period = { createdAt: { $gte: from, $lte: to } };
  const [sales, collected] = await Promise.all([
    salesReport('customer', from, to),
    collectedByCustomer(period),
  ]);
  const salesBy = new Map(sales.rows.map((r) => [r.id, r]));
  const customers = await CustomerModel.find({
    $or: [
      { _id: { $in: [...salesBy.keys(), ...collected.keys()].filter((id) => id !== '—') } },
      { debit: { $ne: 0 } },
      { credit: { $ne: 0 } },
    ],
  }).select('name governorate debit credit');

  const rows = customers.map((c) => {
    const s = salesBy.get(c.id as string);
    return {
      customer: { id: c.id as string, name: c.name, governorate: c.governorate },
      invoices: s?.invoices ?? 0,
      sales: s?.sales ?? 0,
      returns: s?.returns ?? 0,
      net: s?.net ?? 0,
      profit: s?.profit ?? 0,
      collected: collected.get(c.id as string) ?? 0,
      balance: round2(c.debit - c.credit),
    };
  });
  rows.sort((a, b) => b.net - a.net || b.balance - a.balance);
  return {
    rows,
    totals: {
      invoices: sales.totals.invoices,
      sales: sum(rows, (r) => r.sales),
      returns: sum(rows, (r) => r.returns),
      net: sum(rows, (r) => r.net),
      profit: sum(rows, (r) => r.profit),
      collected: sum(rows, (r) => r.collected),
      balance: sum(rows, (r) => r.balance),
    },
  };
}

/** One customer in the period: totals, what they bought (per product), and every document. */
export async function customerReport(id: string, from: Date, to: Date) {
  const customer = Types.ObjectId.isValid(id)
    ? await CustomerModel.findById(id).select('name governorate phone debit credit')
    : null;
  if (!customer) throw new AppError(404, 'Customer not found');
  const match = { customer: customer._id, createdAt: { $gte: from, $lte: to } };
  const [opening, products, invoices, returns, collections] = await Promise.all([
    getCustomerBalance(customer._id, from).then((b) => b.net),
    salesReport('product', from, to, { customer: customer._id }),
    InvoiceModel.find({ ...match, status: InvoiceStatus.ACTIVE }).select(
      'invoiceNumber total paidAmount paymentMethod chequeStatus depositStatus createdAt',
    ),
    ReturnModel.find({ ...match, status: ReturnStatus.ACTIVE }).select('number total createdAt'),
    CollectionModel.find({ ...match, status: CollectionStatus.ACTIVE }).select(
      'receiptNumber amount paymentMethod chequeStatus depositStatus createdAt',
    ),
  ]);

  const { lines, closing } = runBalance([
    ...invoices.map((i) => {
      const bounced = i.chequeStatus === ChequeStatus.BOUNCED;
      return {
        kind: 'invoice' as const,
        id: i.id as string,
        number: String(i.invoiceNumber),
        date: i.createdAt,
        debit: i.total,
        credit: bounced ? 0 : i.paidAmount,
        method: i.paidAmount > 0 ? (i.paymentMethod ?? null) : null,
        bounced,
        pending: i.paidAmount > 0 && i.depositStatus === DepositStatus.PENDING,
      };
    }),
    ...returns.map((r) => ({
      kind: 'return' as const,
      id: r.id as string,
      number: String(r.number),
      date: r.createdAt,
      debit: 0,
      credit: r.total,
      method: null,
      bounced: false,
      pending: false,
    })),
    ...collections.map((c) => {
      const bounced = c.chequeStatus === ChequeStatus.BOUNCED;
      return {
        kind: 'collection' as const,
        id: c.id as string,
        number: String(c.receiptNumber),
        date: c.createdAt,
        debit: 0,
        credit: bounced ? 0 : c.amount,
        method: c.paymentMethod,
        bounced,
        pending: c.depositStatus === DepositStatus.PENDING,
      };
    }),
  ], opening);

  const t = products.totals;
  return {
    customer: {
      id: customer.id as string,
      name: customer.name,
      governorate: customer.governorate,
      phone: customer.phone,
      balance: round2(customer.debit - customer.credit),
    },
    opening,
    closing,
    totals: {
      invoices: t.invoices,
      sales: t.sales,
      returns: t.returns,
      net: t.net,
      cost: t.cost,
      profit: t.profit,
      collected: sum(
        lines.filter((l) => l.kind !== 'return'),
        (l) => l.credit,
      ),
    },
    products: products.rows,
    lines,
  };
}

// ---------- suppliers ----------

/** Every supplier with receipts or payments in the period, or a debt now (what we owe them). */
export async function suppliersReport(from: Date, to: Date) {
  const period = { createdAt: { $gte: from, $lte: to } };
  const [receipts, payments] = await Promise.all([
    MovementModel.aggregate<{ _id: Types.ObjectId; count: number; total: number; paid: number }>([
      { $match: { type: MovementType.RECEIVE, supplier: { $ne: null }, ...period } },
      {
        $group: {
          _id: '$supplier',
          count: { $sum: 1 },
          total: { $sum: '$totalCost' },
          paid: { $sum: '$paidAmount' },
        },
      },
    ]),
    SupplierPaymentModel.aggregate<{ _id: Types.ObjectId; total: number }>([
      { $match: { status: SupplierPaymentStatus.ACTIVE, ...period } },
      { $group: { _id: '$supplier', total: { $sum: '$amount' } } },
    ]),
  ]);
  const receiptsBy = new Map(receipts.map((r) => [String(r._id), r]));
  const paymentsBy = new Map(payments.map((p) => [String(p._id), p.total]));
  const suppliers = await SupplierModel.find({
    $or: [
      { _id: { $in: [...receiptsBy.keys(), ...paymentsBy.keys()] } },
      { debt: { $ne: 0 } },
    ],
  }).select('name phone debt');

  const rows = suppliers.map((s) => {
    const r = receiptsBy.get(s.id as string);
    return {
      supplier: { id: s.id as string, name: s.name, phone: s.phone },
      receipts: r?.count ?? 0,
      purchases: round2(r?.total ?? 0),
      paid: round2((r?.paid ?? 0) + (paymentsBy.get(s.id as string) ?? 0)),
      debt: s.debt,
    };
  });
  rows.sort((a, b) => b.purchases - a.purchases || b.debt - a.debt);
  return {
    rows,
    totals: {
      receipts: rows.reduce((n, r) => n + r.receipts, 0),
      purchases: sum(rows, (r) => r.purchases),
      paid: sum(rows, (r) => r.paid),
      debt: sum(rows, (r) => r.debt),
    },
  };
}

/** One supplier in the period: totals, what we bought (per product), and every receipt / payment. */
export async function supplierReport(id: string, from: Date, to: Date) {
  const supplier = Types.ObjectId.isValid(id)
    ? await SupplierModel.findById(id).select('name phone debt')
    : null;
  if (!supplier) throw new AppError(404, 'Supplier not found');
  const match = { supplier: supplier._id, createdAt: { $gte: from, $lte: to } };
  const [opening, products, receipts, payments] = await Promise.all([
    getSupplierDebt(supplier._id, from),
    purchasesReport(from, to, supplier._id),
    MovementModel.find({ ...match, type: MovementType.RECEIVE }).select(
      'number totalCost paidAmount createdAt',
    ),
    SupplierPaymentModel.find({ ...match, status: SupplierPaymentStatus.ACTIVE }).select(
      'number amount paymentMethod createdAt',
    ),
  ]);

  const { lines, closing } = runBalance([
    ...receipts.map((r) => ({
      kind: 'receipt' as const,
      id: r.id as string,
      number: String(r.number ?? ''),
      date: r.createdAt,
      debit: r.totalCost ?? 0,
      credit: r.paidAmount ?? 0,
      method: null,
      bounced: false,
      pending: false,
    })),
    ...payments.map((p) => ({
      kind: 'payment' as const,
      id: p.id as string,
      number: String(p.number),
      date: p.createdAt,
      debit: 0,
      credit: p.amount,
      method: p.paymentMethod,
      bounced: false,
      pending: false,
    })),
  ], opening);

  return {
    supplier: { id: supplier.id as string, name: supplier.name, phone: supplier.phone, debt: supplier.debt },
    opening,
    closing,
    totals: {
      receipts: receipts.length,
      purchases: sum(lines, (l) => l.debit),
      paid: sum(lines, (l) => l.credit),
    },
    products: products.rows,
    lines,
  };
}
