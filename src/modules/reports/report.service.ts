import type { PipelineStage } from 'mongoose';
import { InvoiceModel } from '../invoices/invoice.model.js';
import { InvoiceStatus } from '../invoices/invoice.types.js';
import { ReturnModel, ReturnStatus } from '../returns/return.model.js';
import { CustomerModel } from '../customers/customer.model.js';
import { UserModel } from '../users/user.model.js';
import { MovementModel } from '../inventory/inventory.model.js';
import { MovementType } from '../inventory/inventory.types.js';

const round2 = (n: number) => Math.round(n * 100) / 100;

export type GroupBy = 'product' | 'governorate' | 'rep';

type Sums = {
  _id: unknown;
  name: string;
  quantity: number;
  amount: number;
  cost: number;
  costMissing: number;
  docs: unknown[];
};

/**
 * Sums lines of invoices (or returns) in the period by product / governorate / rep.
 * Cost = the snapshot on the line; old lines fall back to the product's current average cost.
 */
function sumLines(
  model: typeof InvoiceModel | typeof ReturnModel,
  match: Record<string, unknown>,
  groupBy: GroupBy,
  repField: string,
) {
  const key = { product: '$items.product', governorate: '$customer.governorate', rep: repField }[
    groupBy
  ];
  const pipeline: PipelineStage[] = [
    { $match: match },
    { $unwind: '$items' },
    {
      $lookup: {
        from: 'products',
        localField: 'items.product',
        foreignField: '_id',
        as: 'product',
        pipeline: [{ $project: { avgCost: 1, lastCost: 1 } }],
      },
    },
    {
      $set: {
        unitCost: {
          $ifNull: [
            '$items.unitCost',
            { $first: '$product.avgCost' },
            { $first: '$product.lastCost' },
          ],
        },
      },
    },
  ];
  if (groupBy === 'governorate') {
    pipeline.push(
      {
        $lookup: {
          from: 'customers',
          localField: 'customer',
          foreignField: '_id',
          as: 'customer',
          pipeline: [{ $project: { governorate: 1 } }],
        },
      },
      { $set: { customer: { $first: '$customer' } } },
    );
  }
  if (repField === '$invoice.createdBy') {
    // Returns count against the rep who made the sale.
    pipeline.push(
      {
        $lookup: {
          from: 'invoices',
          localField: 'invoice',
          foreignField: '_id',
          as: 'invoice',
          pipeline: [{ $project: { createdBy: 1 } }],
        },
      },
      { $set: { invoice: { $first: '$invoice' } } },
    );
  }
  pipeline.push({
    $group: {
      _id: key,
      name: { $first: '$items.name' },
      quantity: { $sum: '$items.quantity' },
      amount: { $sum: '$items.total' },
      cost: { $sum: { $multiply: ['$items.quantity', { $ifNull: ['$unitCost', 0] }] } },
      costMissing: { $sum: { $cond: [{ $eq: [{ $ifNull: ['$unitCost', null] }, null] }, 1, 0] } },
      docs: { $addToSet: '$_id' },
    },
  });
  return (model as typeof InvoiceModel).aggregate<Sums>(pipeline);
}

export type SalesRow = {
  id: string;
  name: string;
  quantity: number; // sold - returned
  invoices: number;
  sales: number;
  returns: number;
  net: number;
  cost: number;
  profit: number;
  /** Some lines had no purchase price: their cost counts as 0, so profit is too high. */
  costMissing: boolean;
};

/** Net sales (minus returns), cost and profit per product / governorate / rep in [from, to]. */
export async function salesReport(groupBy: GroupBy, from: Date, to: Date) {
  const period = { createdAt: { $gte: from, $lte: to } };
  const active = { status: InvoiceStatus.ACTIVE, ...period };
  const [sold, returned, invoiceCount] = await Promise.all([
    sumLines(InvoiceModel, active, groupBy, '$createdBy'),
    sumLines(
      ReturnModel,
      { status: ReturnStatus.ACTIVE, ...period },
      groupBy,
      '$invoice.createdBy',
    ),
    InvoiceModel.countDocuments(active), // rows can share an invoice (several products)
  ]);

  const rows = new Map<string, SalesRow>();
  const row = (s: Sums) => {
    const id = String(s._id ?? '—');
    if (!rows.has(id)) {
      rows.set(id, {
        id,
        name: groupBy === 'product' ? s.name : id,
        quantity: 0,
        invoices: 0,
        sales: 0,
        returns: 0,
        net: 0,
        cost: 0,
        profit: 0,
        costMissing: false,
      });
    }
    return rows.get(id)!;
  };
  for (const s of sold) {
    const r = row(s);
    r.quantity += s.quantity;
    r.invoices = s.docs.length;
    r.sales = round2(s.amount);
    r.cost = round2(r.cost + s.cost);
    r.costMissing ||= s.costMissing > 0;
  }
  for (const s of returned) {
    const r = row(s);
    r.quantity -= s.quantity;
    r.returns = round2(s.amount);
    r.cost = round2(r.cost - s.cost);
  }

  if (groupBy === 'rep') {
    const users = await UserModel.find({
      _id: { $in: [...rows.keys()].filter((k) => k !== '—') },
    }).select('name');
    for (const u of users) rows.get(u.id as string)!.name = u.name;
  }

  const list = [...rows.values()].map((r) => {
    const net = round2(r.sales - r.returns);
    return { ...r, net, profit: round2(net - r.cost) };
  });
  list.sort((a, b) => b.net - a.net);
  const total = (f: 'sales' | 'returns' | 'net' | 'cost' | 'profit') =>
    round2(list.reduce((s, r) => s + r[f], 0));
  return {
    rows: list,
    totals: {
      invoices: invoiceCount,
      sales: total('sales'),
      returns: total('returns'),
      net: total('net'),
      cost: total('cost'),
      profit: total('profit'),
    },
  };
}

const DAY = 86_400_000;
export const AGING_BUCKETS = ['لم يستحق', '0-30', '31-60', '61-90', '90+'] as const;

/** Which bucket an invoice falls in, by days since its due date (negative = not due yet). */
export const bucketOf = (days: number) =>
  days < 0 ? 0 : days <= 30 ? 1 : days <= 60 ? 2 : days <= 90 ? 3 : 4;

/**
 * Splits a debt over invoices by age, FIFO: payments settle the oldest invoices first,
 * so what is still owed belongs to the newest ones. `invoices` newest first.
 * Age counts from the due date; an invoice without one (no payment terms) is due on its date.
 * `oldestDays` = days past due of the oldest invoice still owed (negative = not due yet).
 */
export function ageDebt(
  debt: number,
  invoices: { createdAt: Date; total: number; dueDate?: Date | null }[],
  now: Date,
) {
  const buckets = [0, 0, 0, 0, 0];
  let left = debt;
  let oldestDays = 0;
  for (const inv of invoices) {
    if (left <= 0) break;
    const part = Math.min(left, inv.total);
    const due = inv.dueDate ?? inv.createdAt;
    const days = Math.floor((now.getTime() - due.getTime()) / DAY);
    buckets[bucketOf(days)] += part;
    oldestDays = days;
    left = round2(left - part);
  }
  buckets[4] += Math.max(left, 0); // not covered by invoices (shouldn't happen): oldest bucket
  return { buckets: buckets.map(round2), oldestDays };
}

/** أعمار الديون: every customer who owes money, their debt split by the age of the unpaid invoices. */
export async function agingReport(now = new Date()) {
  const customers = await CustomerModel.find({ debit: { $gt: 0 } })
    .select('name governorate phone debit pendingPayments')
    .sort({ debit: -1 });
  // ponytail: loads every active invoice of these customers; page or cap if it gets slow.
  const invoices = await InvoiceModel.aggregate<{
    _id: unknown;
    list: { createdAt: Date; total: number; dueDate: Date | null }[];
  }>([
    { $match: { customer: { $in: customers.map((c) => c._id) }, status: InvoiceStatus.ACTIVE } },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: '$customer',
        list: { $push: { createdAt: '$createdAt', total: '$total', dueDate: '$dueDate' } },
      },
    },
  ]);
  const byCustomer = new Map(invoices.map((i) => [String(i._id), i.list]));

  const rows = customers.map((c) => {
    const { buckets, oldestDays } = ageDebt(c.debit, byCustomer.get(c.id as string) ?? [], now);
    return {
      customer: { id: c.id as string, name: c.name, governorate: c.governorate, phone: c.phone },
      debt: c.debit,
      pending: c.pendingPayments,
      buckets,
      oldestDays,
    };
  });
  return {
    buckets: AGING_BUCKETS,
    rows,
    totals: {
      debt: round2(rows.reduce((s, r) => s + r.debt, 0)),
      pending: round2(rows.reduce((s, r) => s + r.pending, 0)),
      buckets: AGING_BUCKETS.map((_, i) => round2(rows.reduce((s, r) => s + r.buckets[i]!, 0))),
    },
  };
}

/**
 * مشتريات الصنف: what each supplier sold each product for (receipts), optionally in [from, to].
 * One row per product + supplier, cheapest average first within a product.
 */
export async function purchasesReport(from?: Date, to?: Date) {
  const rows = await MovementModel.aggregate<{
    product: { id: string; name: string };
    supplier: { id: string; name: string };
    receipts: number;
    quantity: number;
    total: number;
    avgCost: number;
    minCost: number;
    maxCost: number;
    lastCost: number;
    lastAt: Date;
    currentAvgCost: number | null;
  }>([
    {
      $match: {
        type: MovementType.RECEIVE,
        ...((from || to) && {
          createdAt: { ...(from && { $gte: from }), ...(to && { $lte: to }) },
        }),
      },
    },
    { $sort: { createdAt: 1 } }, // so $last is the latest purchase
    { $unwind: '$items' },
    {
      $group: {
        _id: { product: '$items.product', supplier: '$supplier' },
        name: { $last: '$items.name' },
        receipts: { $addToSet: '$_id' },
        quantity: { $sum: '$items.quantity' },
        total: { $sum: { $multiply: ['$items.quantity', { $ifNull: ['$items.unitCost', 0] }] } },
        minCost: { $min: '$items.unitCost' },
        maxCost: { $max: '$items.unitCost' },
        lastCost: { $last: '$items.unitCost' },
        lastAt: { $last: '$createdAt' },
      },
    },
    {
      $lookup: {
        from: 'suppliers',
        localField: '_id.supplier',
        foreignField: '_id',
        as: 'supplierDoc',
        pipeline: [{ $project: { name: 1 } }],
      },
    },
    {
      $lookup: {
        from: 'products',
        localField: '_id.product',
        foreignField: '_id',
        as: 'productDoc',
        pipeline: [{ $project: { name: 1, avgCost: 1 } }],
      },
    },
    {
      $project: {
        _id: 0,
        product: {
          id: { $toString: '$_id.product' },
          name: { $ifNull: [{ $first: '$productDoc.name' }, '$name'] },
        },
        supplier: {
          id: { $toString: '$_id.supplier' },
          name: { $ifNull: [{ $first: '$supplierDoc.name' }, '—'] },
        },
        receipts: { $size: '$receipts' },
        quantity: 1,
        total: 1,
        avgCost: {
          $cond: [{ $gt: ['$quantity', 0] }, { $divide: ['$total', '$quantity'] }, 0],
        },
        minCost: 1,
        maxCost: 1,
        lastCost: 1,
        lastAt: 1,
        currentAvgCost: { $first: '$productDoc.avgCost' },
      },
    },
  ]);
  for (const r of rows) {
    r.total = round2(r.total);
    r.avgCost = round2(r.avgCost);
  }
  rows.sort((a, b) => a.product.name.localeCompare(b.product.name, 'ar') || a.avgCost - b.avgCost);
  return {
    rows,
    totals: {
      quantity: rows.reduce((s, r) => s + r.quantity, 0),
      total: round2(rows.reduce((s, r) => s + r.total, 0)),
    },
  };
}
