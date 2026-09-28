import { Types } from 'mongoose';
import { DepositModel } from './deposit.model.js';
import { DepositStatus } from './treasury.types.js';
import type { CreateDepositInput } from './treasury.validation.js';
import { InvoiceModel } from '../invoices/invoice.model.js';
import { InvoiceStatus } from '../invoices/invoice.types.js';
import { CollectionModel } from '../collections/collection.model.js';
import { CollectionStatus } from '../collections/collection.types.js';
import { syncCustomerSummary } from '../customers/customer-balance.js';
import { UserModel, type UserDocument } from '../users/user.model.js';
import { UserRole } from '../users/user.types.js';
import { AppError } from '../../utils/api-response.js';

const isManager = (actor: UserDocument) =>
  actor.role === UserRole.OWNER || actor.role === UserRole.ADMIN;

const round2 = (n: number) => Math.round(n * 100) / 100;

const pendingInvoice = {
  status: InvoiceStatus.ACTIVE,
  depositStatus: DepositStatus.PENDING,
  paidAmount: { $gt: 0 },
};
const pendingCollection = { status: CollectionStatus.ACTIVE, depositStatus: DepositStatus.PENDING };

/** One money entry in a rep's cash box or in a handover. */
type Payment = {
  kind: 'INVOICE' | 'COLLECTION';
  id: string;
  number: string;
  customer: unknown;
  rep: unknown;
  amount: number;
  paymentMethod: string | null | undefined;
  chequeNumber: string | null | undefined;
  chequeDueDate: Date | null | undefined;
  createdAt: Date;
};

const refs = [
  { path: 'customer', select: 'name governorate' },
  { path: 'createdBy', select: 'name' },
];

async function loadPayments(
  invoiceFilter: Record<string, unknown>,
  collectionFilter: Record<string, unknown>,
): Promise<Payment[]> {
  const [invoices, collections] = await Promise.all([
    InvoiceModel.find(invoiceFilter).populate(refs),
    CollectionModel.find(collectionFilter).populate(refs),
  ]);
  return [
    ...invoices.map((i) => ({
      kind: 'INVOICE' as const,
      id: i.id as string,
      number: i.invoiceNumber,
      customer: i.customer,
      rep: i.createdBy,
      amount: i.paidAmount,
      paymentMethod: i.paymentMethod,
      chequeNumber: i.chequeNumber,
      chequeDueDate: i.chequeDueDate,
      createdAt: i.createdAt,
    })),
    ...collections.map((c) => ({
      kind: 'COLLECTION' as const,
      id: c.id as string,
      number: c.receiptNumber,
      customer: c.customer,
      rep: c.createdBy,
      amount: c.amount,
      paymentMethod: c.paymentMethod,
      chequeNumber: c.chequeNumber,
      chequeDueDate: c.chequeDueDate,
      createdAt: c.createdAt,
    })),
  ].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

/** Money still in reps' cash boxes. A rep only sees their own. */
export function listPending(repId: string | undefined, actor: UserDocument) {
  const rep = isManager(actor) ? repId : actor.id;
  const byRep = rep ? { createdBy: rep } : {};
  return loadPayments({ ...pendingInvoice, ...byRep }, { ...pendingCollection, ...byRep });
}

type Sum = { _id: unknown; total: number; count: number };

async function sumBy(field: string, invoiceMatch: object, collectionMatch: object) {
  const [invoices, collections] = await Promise.all([
    InvoiceModel.aggregate<Sum>([
      { $match: invoiceMatch },
      { $group: { _id: `$${field}`, total: { $sum: '$paidAmount' }, count: { $sum: 1 } } },
    ]),
    CollectionModel.aggregate<Sum>([
      { $match: collectionMatch },
      { $group: { _id: `$${field}`, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
  ]);
  const merged = new Map<string, { total: number; count: number }>();
  for (const row of [...invoices, ...collections]) {
    const key = String(row._id);
    const prev = merged.get(key) ?? { total: 0, count: 0 };
    merged.set(key, { total: round2(prev.total + row.total), count: prev.count + row.count });
  }
  return merged;
}

/** Treasury balance by payment method, and what each rep still holds. Managers only. */
export async function getSummary() {
  const deposited = { $ne: DepositStatus.PENDING };
  const [inTreasury, pendingByRep] = await Promise.all([
    sumBy(
      'paymentMethod',
      { status: InvoiceStatus.ACTIVE, paidAmount: { $gt: 0 }, depositStatus: deposited },
      { status: CollectionStatus.ACTIVE, depositStatus: deposited },
    ),
    sumBy('createdBy', pendingInvoice, pendingCollection),
  ]);
  const reps = await UserModel.find({ _id: { $in: [...pendingByRep.keys()] } }).select('name');
  const byMethod = [...inTreasury].map(([method, v]) => ({ method, ...v }));
  return {
    total: round2(byMethod.reduce((sum, m) => sum + m.total, 0)),
    byMethod,
    pendingByRep: reps
      .map((rep) => ({
        rep: { id: rep.id as string, name: rep.name },
        ...pendingByRep.get(rep.id)!,
      }))
      .sort((a, b) => b.total - a.total),
  };
}

/**
 * Records a handover: the selected payments leave the rep's cash box, enter the treasury,
 * and only now reduce each customer's debt.
 * ponytail: no transaction; the conditional updates only touch entries that are still pending,
 * and the deposit total is taken from what was actually updated.
 */
export async function createDeposit(input: CreateDepositInput, actor: UserDocument) {
  const rep = await UserModel.findOne({ _id: input.repId, role: UserRole.SALES_REP });
  if (!rep) throw new AppError(404, 'Sales rep not found');

  const byRep = { createdBy: rep._id };
  const [invoices, collections] = await Promise.all([
    InvoiceModel.find({ _id: { $in: input.invoiceIds }, ...pendingInvoice, ...byRep }),
    CollectionModel.find({ _id: { $in: input.collectionIds }, ...pendingCollection, ...byRep }),
  ]);
  if (
    invoices.length !== input.invoiceIds.length ||
    collections.length !== input.collectionIds.length
  ) {
    throw new AppError(400, 'Some payments are not pending with this rep');
  }

  const last = await DepositModel.findOne().sort({ number: -1 }).select('number');
  const deposit = await DepositModel.create({
    number: (last?.number ?? 0) + 1,
    rep: rep._id,
    receivedBy: actor._id,
    invoices: invoices.map((i) => i._id),
    collections: collections.map((c) => c._id),
    total: round2(
      invoices.reduce((s, i) => s + i.paidAmount, 0) +
        collections.reduce((s, c) => s + c.amount, 0),
    ),
    notes: input.notes,
  });

  const set = {
    depositStatus: DepositStatus.DEPOSITED,
    deposit: deposit._id,
    depositedAt: new Date(),
  };
  await Promise.all([
    InvoiceModel.updateMany({ _id: { $in: deposit.invoices }, ...pendingInvoice }, set),
    CollectionModel.updateMany({ _id: { $in: deposit.collections }, ...pendingCollection }, set),
  ]);

  const customers = new Set([...invoices, ...collections].map((p) => String(p.customer)));
  for (const id of customers) await syncCustomerSummary(new Types.ObjectId(id));
  return getDeposit(deposit.id as string, actor);
}

const depositRefs = [{ path: 'rep receivedBy', select: 'name' }];

/** Reps only see their own handovers. */
export function listDeposits(repId: string | undefined, actor: UserDocument) {
  const rep = isManager(actor) ? repId : actor.id;
  return DepositModel.find(rep ? { rep } : {})
    .sort({ createdAt: -1 })
    .limit(300) // ponytail: fixed cap, add paging when needed
    .populate(depositRefs);
}

export async function getDeposit(id: string, actor: UserDocument) {
  const deposit = await DepositModel.findOne({
    _id: id,
    ...(!isManager(actor) && { rep: actor._id }),
  }).populate(depositRefs);
  if (!deposit) throw new AppError(404, 'Deposit not found');
  const payments = await loadPayments(
    { _id: { $in: deposit.invoices } },
    { _id: { $in: deposit.collections } },
  );
  return { ...deposit.toJSON(), payments };
}
