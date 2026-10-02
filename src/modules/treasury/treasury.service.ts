import { Types } from 'mongoose';
import { DepositModel } from './deposit.model.js';
import { TreasuryEntryModel } from './treasury-entry.model.js';
import {
  ChequeStatus,
  DepositStatus,
  TreasuryEntryStatus,
  TreasuryEntryType,
} from './treasury.types.js';
import type {
  CreateDepositInput,
  CreateEntryInput,
  CreateRepExpenseInput,
  ListEntriesFilters,
} from './treasury.validation.js';
import { InvoiceModel } from '../invoices/invoice.model.js';
import { InvoiceStatus, PaymentMethod } from '../invoices/invoice.types.js';
import { SupplierPaymentModel } from '../suppliers/supplier-payment.model.js';
import { SupplierPaymentStatus } from '../suppliers/supplier-payment.types.js';
import { MovementModel } from '../inventory/inventory.model.js';
import { MovementType } from '../inventory/inventory.types.js';
import { CollectionModel } from '../collections/collection.model.js';
import { CollectionStatus } from '../collections/collection.types.js';
import { syncCustomerSummary } from '../customers/customer-balance.js';
import { UserModel, type UserDocument } from '../users/user.model.js';
import { UserRole } from '../users/user.types.js';
import { AppError } from '../../utils/api-response.js';
import { CASH_TAKEN, REP_EXPENSE, notify } from '../notifications/notification.service.js';
import { DocumentType } from '../documents/documents.routes.js';

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
  chequeStatus: string | null | undefined;
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
      chequeStatus: i.chequeStatus,
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
      chequeStatus: c.chequeStatus,
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

/** `key` is a field name or a $group expression. */
async function sumBy(key: string | object, invoiceMatch: object, collectionMatch: object) {
  const _id = typeof key === 'string' ? `$${key}` : key;
  const [invoices, collections] = await Promise.all([
    InvoiceModel.aggregate<Sum>([
      { $match: invoiceMatch },
      { $group: { _id, total: { $sum: '$paidAmount' }, count: { $sum: 1 } } },
    ]),
    CollectionModel.aggregate<Sum>([
      { $match: collectionMatch },
      { $group: { _id, total: { $sum: '$amount' }, count: { $sum: 1 } } },
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

/**
 * Supplier money leaves the treasury only from this day on: older payments were made before the
 * treasury tracked outflows (same idea as old payments counting as DEPOSITED).
 */
export const SUPPLIER_OUTFLOWS_FROM = new Date(2026, 8, 30);

/** What left each payment-method bucket: entries, supplier payments and paid receipts. */
async function outflowsByMethod() {
  const [entries, supplierPayments, [receipts]] = await Promise.all([
    TreasuryEntryModel.aggregate<{ _id: { type: string; method: string }; total: number }>([
      // A rep's expense leaves the treasury only once accepted in a handover.
      {
        $match: {
          status: TreasuryEntryStatus.ACTIVE,
          depositStatus: { $ne: DepositStatus.PENDING },
        },
      },
      {
        $group: {
          _id: { type: '$type', method: '$paymentMethod' },
          total: { $sum: '$amount' },
        },
      },
    ]),
    SupplierPaymentModel.aggregate<{ _id: string; total: number }>([
      {
        $match: {
          status: SupplierPaymentStatus.ACTIVE,
          createdAt: { $gte: SUPPLIER_OUTFLOWS_FROM },
        },
      },
      { $group: { _id: '$paymentMethod', total: { $sum: '$amount' } } },
    ]),
    MovementModel.aggregate<{ total: number }>([
      {
        $match: {
          type: MovementType.RECEIVE,
          paidAmount: { $gt: 0 },
          createdAt: { $gte: SUPPLIER_OUTFLOWS_FROM },
        },
      },
      { $group: { _id: null, total: { $sum: '$paidAmount' } } },
    ]),
  ]);
  const out = new Map<string, number>();
  const take = (method: string, amount: number) =>
    out.set(method, round2((out.get(method) ?? 0) + amount));
  for (const e of entries) {
    take(e._id.method, e.total);
    // A bank deposit only moves the money into the bank bucket.
    if (e._id.type === TreasuryEntryType.BANK_DEPOSIT) take(PaymentMethod.BANK_TRANSFER, -e.total);
  }
  // ponytail: a cheque the company writes is drawn on the bank, and receipts have no payment
  // method so they count as cash; add a method to receipts if that's ever wrong.
  for (const p of supplierPayments) {
    take(p._id === PaymentMethod.CHEQUE ? PaymentMethod.BANK_TRANSFER : p._id, p.total);
  }
  if (receipts) take(PaymentMethod.CASH, receipts.total);
  return out;
}

/** A cheque that was cashed now sits in the bank. */
const bucket = {
  $cond: [
    { $eq: ['$chequeStatus', ChequeStatus.CLEARED] },
    PaymentMethod.BANK_TRANSFER,
    '$paymentMethod',
  ],
};

const pendingExpense = {
  rep: { $ne: null },
  status: TreasuryEntryStatus.ACTIVE,
  depositStatus: DepositStatus.PENDING,
};

async function pendingExpensesByRep(repId?: Types.ObjectId) {
  const rows = await TreasuryEntryModel.aggregate<{ _id: Types.ObjectId; total: number }>([
    { $match: { ...pendingExpense, ...(repId && { rep: repId }) } },
    { $group: { _id: '$rep', total: { $sum: '$amount' } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), round2(r.total)]));
}

/** What a rep holds now: collected (not handed over) minus their pending expenses. */
export async function cashBoxOf(repId: Types.ObjectId) {
  const [payments, spent] = await Promise.all([
    loadPayments(
      { ...pendingInvoice, createdBy: repId },
      { ...pendingCollection, createdBy: repId },
    ),
    pendingExpensesByRep(repId),
  ]);
  const collected = round2(payments.reduce((s, p) => s + p.amount, 0));
  const cash = round2(
    payments
      .filter((p) => p.paymentMethod === PaymentMethod.CASH)
      .reduce((s, p) => s + p.amount, 0),
  );
  const expenses = spent.get(String(repId)) ?? 0;
  return {
    total: round2(collected - expenses),
    count: payments.length,
    expenses,
    cash: round2(cash - expenses),
  };
}

/** Treasury balance by payment method, and what each rep still holds. Managers only. */
export async function getSummary() {
  const inTreasury = { $ne: DepositStatus.PENDING };
  const notBounced = { $ne: ChequeStatus.BOUNCED };
  const [received, pendingByRep, out, expensesByRep] = await Promise.all([
    sumBy(
      bucket,
      {
        status: InvoiceStatus.ACTIVE,
        paidAmount: { $gt: 0 },
        depositStatus: inTreasury,
        chequeStatus: notBounced,
      },
      { status: CollectionStatus.ACTIVE, depositStatus: inTreasury, chequeStatus: notBounced },
    ),
    sumBy('createdBy', pendingInvoice, pendingCollection),
    outflowsByMethod(),
    pendingExpensesByRep(),
  ]);
  // What a rep holds = collected − spent (their expenses not handed over yet).
  for (const [rep, spent] of expensesByRep) {
    const prev = pendingByRep.get(rep) ?? { total: 0, count: 0 };
    pendingByRep.set(rep, { total: round2(prev.total - spent), count: prev.count });
  }
  const reps = await UserModel.find({ _id: { $in: [...pendingByRep.keys()] } }).select('name');
  const byMethod = [...new Set([...received.keys(), ...out.keys()])]
    .map((method) => ({
      method,
      total: round2((received.get(method)?.total ?? 0) - (out.get(method) ?? 0)),
      count: received.get(method)?.count ?? 0, // payments received
    }))
    .filter((m) => m.total !== 0 || m.count > 0);
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
  const [invoices, collections, expenses] = await Promise.all([
    InvoiceModel.find({ _id: { $in: input.invoiceIds }, ...pendingInvoice, ...byRep }),
    CollectionModel.find({ _id: { $in: input.collectionIds }, ...pendingCollection, ...byRep }),
    TreasuryEntryModel.find({ _id: { $in: input.expenseIds }, ...pendingExpense, rep: rep._id }),
  ]);
  if (
    invoices.length !== input.invoiceIds.length ||
    collections.length !== input.collectionIds.length ||
    expenses.length !== input.expenseIds.length
  ) {
    throw new AppError(400, 'Some payments are not pending with this rep');
  }
  const received = round2(
    invoices.reduce((s, i) => s + i.paidAmount, 0) + collections.reduce((s, c) => s + c.amount, 0),
  );
  // Expenses were paid in cash, so they come out of the cash handed over in this same handover.
  const receivedCash = round2(
    invoices
      .filter((i) => i.paymentMethod === PaymentMethod.CASH)
      .reduce((s, i) => s + i.paidAmount, 0) +
      collections
        .filter((c) => c.paymentMethod === PaymentMethod.CASH)
        .reduce((s, c) => s + c.amount, 0),
  );
  const spent = round2(expenses.reduce((s, e) => s + e.amount, 0));
  if (spent > receivedCash) throw new AppError(400, 'Expenses exceed the cash handed over');

  const last = await DepositModel.findOne().sort({ number: -1 }).select('number');
  const deposit = await DepositModel.create({
    number: (last?.number ?? 0) + 1,
    rep: rep._id,
    receivedBy: actor._id,
    invoices: invoices.map((i) => i._id),
    collections: collections.map((c) => c._id),
    expenses: expenses.map((e) => e._id),
    total: round2(received - spent),
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
    TreasuryEntryModel.updateMany(
      { _id: { $in: deposit.expenses }, ...pendingExpense },
      { depositStatus: DepositStatus.DEPOSITED, deposit: deposit._id },
    ),
  ]);

  const customers = new Set([...invoices, ...collections].map((p) => String(p.customer)));
  for (const id of customers) await syncCustomerSummary(new Types.ObjectId(id));
  await notify(
    {
      type: DocumentType.DEPOSIT,
      docId: deposit.id,
      number: deposit.number,
      party: rep,
      amount: deposit.total,
    },
    actor,
  );
  await notify({ type: CASH_TAKEN, docId: deposit.id, number: null }, null, rep._id, false);
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
  const [payments, expenses] = await Promise.all([
    loadPayments({ _id: { $in: deposit.invoices } }, { _id: { $in: deposit.collections } }),
    TreasuryEntryModel.find({ _id: { $in: deposit.expenses ?? [] } }).populate(entryRefs),
  ]);
  return { ...deposit.toJSON(), payments, expenses };
}

const entryRefs = [
  { path: 'createdBy cancelledBy rep', select: 'name' },
  { path: 'deposit', select: 'number createdAt' },
];

/** Managers: every entry (filters optional). A rep: only their own expenses. */
export function listEntries({ type, repId, pending }: ListEntriesFilters, actor: UserDocument) {
  const rep = isManager(actor) ? repId : actor.id;
  return TreasuryEntryModel.find({
    ...(type && { type }),
    ...(rep && { rep }),
    ...(pending && pendingExpense),
  })
    .sort({ createdAt: -1 })
    .limit(300) // ponytail: fixed cap, add paging when needed
    .populate(entryRefs);
}

/** Expense / withdrawal / bank deposit. Not capped: the treasury only tracks money in and out, so a bucket may go negative. */
export async function createEntry(input: CreateEntryInput, actor: UserDocument) {
  const amount = round2(input.amount);
  const last = await TreasuryEntryModel.findOne().sort({ number: -1 }).select('number');
  const entry = await TreasuryEntryModel.create({
    number: (last?.number ?? 0) + 1,
    type: input.type,
    amount,
    paymentMethod: input.paymentMethod,
    category: input.type === TreasuryEntryType.EXPENSE ? input.category : null,
    notes: input.notes,
    createdBy: actor._id,
  });
  return entry.populate(entryRefs);
}

/**
 * مصروف مندوب: paid from the rep's own cash, so capped at the cash they hold (cheques can't be spent).
 * ponytail: the check and insert are not atomic, same as collections.
 */
export async function createRepExpense(input: CreateRepExpenseInput, actor: UserDocument) {
  const amount = round2(input.amount);
  const { cash } = await cashBoxOf(actor._id);
  if (amount > cash)
    throw new AppError(400, `Amount exceeds the cash you hold (${Math.max(cash, 0)})`);
  const last = await TreasuryEntryModel.findOne().sort({ number: -1 }).select('number');
  const entry = await TreasuryEntryModel.create({
    number: (last?.number ?? 0) + 1,
    type: TreasuryEntryType.EXPENSE,
    amount,
    paymentMethod: PaymentMethod.CASH,
    category: input.category,
    notes: input.notes,
    createdBy: actor._id,
    rep: actor._id,
    depositStatus: DepositStatus.PENDING,
  });
  await notify(
    { type: REP_EXPENSE, docId: entry.id, number: entry.number, party: actor, amount },
    actor,
  );
  return entry.populate(entryRefs);
}

/** A rep cancels only their own expense, and only before the handover. */
export async function cancelEntry(id: string, reason: string, actor: UserDocument) {
  const entry = await TreasuryEntryModel.findOne({
    _id: id,
    ...(!isManager(actor) && { rep: actor._id, depositStatus: DepositStatus.PENDING }),
  });
  if (!entry) throw new AppError(404, 'Entry not found');
  if (entry.status === TreasuryEntryStatus.CANCELLED)
    throw new AppError(400, 'Entry is already cancelled');
  entry.set({
    status: TreasuryEntryStatus.CANCELLED,
    cancelReason: reason,
    cancelledBy: actor._id,
    cancelledAt: new Date(),
  });
  await entry.save();
  return entry.populate(entryRefs);
}

/** Received cheques in the treasury that were not cashed or bounced yet. */
const openCheque = {
  paymentMethod: PaymentMethod.CHEQUE,
  depositStatus: { $ne: DepositStatus.PENDING },
  chequeStatus: null,
};

export function listCheques() {
  return loadPayments(
    { ...openCheque, status: InvoiceStatus.ACTIVE, paidAmount: { $gt: 0 } },
    { ...openCheque, status: CollectionStatus.ACTIVE },
  );
}

/** CLEARED moves the cheque to the bank; BOUNCED puts its amount back on the customer's debt. */
export async function setChequeStatus(
  id: string,
  kind: 'INVOICE' | 'COLLECTION',
  status: ChequeStatus,
  actor: UserDocument,
) {
  const set = { chequeStatus: status, chequeStatusAt: new Date(), chequeStatusBy: actor._id };
  const opts = { returnDocument: 'after' as const };
  const doc =
    kind === 'INVOICE'
      ? await InvoiceModel.findOneAndUpdate(
          { _id: id, ...openCheque, status: InvoiceStatus.ACTIVE, paidAmount: { $gt: 0 } },
          set,
          opts,
        )
      : await CollectionModel.findOneAndUpdate(
          { _id: id, ...openCheque, status: CollectionStatus.ACTIVE },
          set,
          opts,
        );
  if (!doc) throw new AppError(400, 'Cheque is not in the treasury');
  if (status === ChequeStatus.BOUNCED) await syncCustomerSummary(doc.customer);
  return { id: doc.id as string, kind, chequeStatus: doc.chequeStatus };
}
