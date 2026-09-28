import { Types } from 'mongoose';
import { InvoiceModel } from '../invoices/invoice.model.js';
import { InvoiceStatus, PaymentMethod } from '../invoices/invoice.types.js';
import { CollectionModel } from '../collections/collection.model.js';
import { CollectionStatus } from '../collections/collection.types.js';
import { VisitModel } from '../visits/visit.model.js';
import { VisitStatus } from '../visits/visit.types.js';
import { CustomerModel } from '../customers/customer.model.js';
import { CustomerStatus } from '../customers/customer.types.js';
import { visibilityFilter } from '../customers/customer.service.js';
import { ProductModel } from '../products/product.model.js';
import { StockModel } from '../inventory/inventory.model.js';
import { totalsByProduct } from '../inventory/inventory.service.js';
import { getSummary, listPending } from '../treasury/treasury.service.js';
import { UserModel, type UserDocument } from '../users/user.model.js';
import { UserRole } from '../users/user.types.js';

const isManager = (actor: UserDocument) =>
  actor.role === UserRole.OWNER || actor.role === UserRole.ADMIN;

const round2 = (n: number) => Math.round(n * 100) / 100;

// ponytail: days follow the server's time zone; set TZ=Africa/Cairo on the server.
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const dayKey = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD

type Row = {
  _id: { rep: Types.ObjectId; day: string };
  amount: number;
  paid: number;
  count: number;
};

/** Month-to-date money grouped by rep and day; everything else is derived from these rows. */
function moneyByRepAndDay(
  model: typeof InvoiceModel | typeof CollectionModel,
  match: Record<string, unknown>,
  amountField: string,
  paidField: string,
) {
  return (model as typeof InvoiceModel).aggregate<Row>([
    { $match: match },
    {
      $group: {
        _id: {
          rep: '$createdBy',
          day: { $dateToString: { date: '$createdAt', format: '%Y-%m-%d', timezone: TZ } },
        },
        amount: { $sum: `$${amountField}` },
        paid: { $sum: `$${paidField}` },
        count: { $sum: 1 },
      },
    },
  ]);
}

const sum = (
  rows: Row[],
  field: 'amount' | 'paid' | 'count',
  where: (r: Row) => boolean = () => true,
) => round2(rows.filter(where).reduce((s, r) => s + r[field], 0));

/** Everything the home page shows, scoped to the rep for sales reps. */
export async function getDashboard(actor: UserDocument) {
  const manager = isManager(actor);
  const now = new Date();
  const today = dayKey(now);
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(startOfDay.getTime() + 86_400_000);
  const startOfMonth = new Date(startOfDay.getFullYear(), startOfDay.getMonth(), 1);
  const in14Days = new Date(startOfDay.getTime() + 15 * 86_400_000);

  const mine = manager ? {} : { createdBy: actor._id };
  const myVisits = manager ? {} : { salesRep: actor._id };
  const customerScope = visibilityFilter(actor);
  const monthly = { createdAt: { $gte: startOfMonth } };
  const activeInvoice = { status: InvoiceStatus.ACTIVE, ...mine };
  const activeCollection = { status: CollectionStatus.ACTIVE, ...mine };
  const cheque = {
    paymentMethod: PaymentMethod.CHEQUE,
    chequeDueDate: { $gte: startOfDay, $lt: in14Days },
  };

  const [
    invoiceRows,
    collectionRows,
    visitRows,
    todayVisits,
    [customers],
    topDebtors,
    recentInvoices,
    chequeInvoices,
    chequeCollections,
  ] = await Promise.all([
    moneyByRepAndDay(InvoiceModel, { ...activeInvoice, ...monthly }, 'total', 'paidAmount'),
    moneyByRepAndDay(CollectionModel, { ...activeCollection, ...monthly }, 'amount', 'amount'),
    VisitModel.aggregate<{
      _id: { rep: Types.ObjectId; status: VisitStatus; today: boolean };
      count: number;
    }>([
      { $match: { ...myVisits, scheduledAt: { $gte: startOfMonth } } },
      {
        $group: {
          _id: {
            rep: '$salesRep',
            status: '$status',
            today: {
              $and: [{ $gte: ['$scheduledAt', startOfDay] }, { $lt: ['$scheduledAt', endOfDay] }],
            },
          },
          count: { $sum: 1 },
        },
      },
    ]),
    VisitModel.find({
      ...myVisits,
      scheduledAt: { $gte: startOfDay, $lt: endOfDay },
      status: { $ne: VisitStatus.CANCELLED },
    })
      .sort({ scheduledAt: 1 })
      .limit(10)
      .populate([
        { path: 'customer', select: 'name governorate' },
        { path: 'salesRep', select: 'name' },
      ]),
    CustomerModel.aggregate<{
      total: number;
      pendingApproval: number;
      debt: number;
      debtors: number;
      pendingPayments: number;
    }>([
      { $match: { ...customerScope, status: { $ne: CustomerStatus.REJECTED } } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          pendingApproval: {
            $sum: { $cond: [{ $eq: ['$status', CustomerStatus.PENDING] }, 1, 0] },
          },
          debt: { $sum: '$debit' },
          debtors: { $sum: { $cond: [{ $gt: ['$debit', 0] }, 1, 0] } },
          pendingPayments: { $sum: '$pendingPayments' },
        },
      },
    ]),
    CustomerModel.find({ ...customerScope, debit: { $gt: 0 } })
      .sort({ debit: -1 })
      .limit(5)
      .select('name governorate debit pendingPayments lastCollection'),
    InvoiceModel.find(mine)
      .sort({ createdAt: -1 })
      .limit(6)
      .select('invoiceNumber customer createdBy total remaining status createdAt')
      .populate([
        { path: 'customer', select: 'name' },
        { path: 'createdBy', select: 'name' },
      ]),
    InvoiceModel.find({ ...activeInvoice, ...cheque, paidAmount: { $gt: 0 } })
      .select('invoiceNumber customer paidAmount chequeNumber chequeDueDate depositStatus')
      .populate({ path: 'customer', select: 'name' }),
    CollectionModel.find({ ...activeCollection, ...cheque })
      .select('receiptNumber customer amount chequeNumber chequeDueDate depositStatus')
      .populate({ path: 'customer', select: 'name' }),
  ]);

  const isToday = (r: Row) => r._id.day === today;
  const days = [...new Set([...invoiceRows, ...collectionRows].map((r) => r._id.day))].sort();
  const visitCount = (where: (v: (typeof visitRows)[number]) => boolean) =>
    visitRows.filter(where).reduce((s, v) => s + v.count, 0);

  const cheques = [
    ...chequeInvoices.map((i) => ({
      kind: 'INVOICE' as const,
      id: i.id as string,
      number: i.invoiceNumber,
      customer: i.customer,
      amount: i.paidAmount,
      chequeNumber: i.chequeNumber,
      dueDate: i.chequeDueDate,
      depositStatus: i.depositStatus,
    })),
    ...chequeCollections.map((c) => ({
      kind: 'COLLECTION' as const,
      id: c.id as string,
      number: c.receiptNumber,
      customer: c.customer,
      amount: c.amount,
      chequeNumber: c.chequeNumber,
      dueDate: c.chequeDueDate,
      depositStatus: c.depositStatus,
    })),
  ].sort((a, b) => a.dueDate!.getTime() - b.dueDate!.getTime());

  const base = {
    sales: {
      today: {
        total: sum(invoiceRows, 'amount', isToday),
        count: sum(invoiceRows, 'count', isToday),
      },
      month: { total: sum(invoiceRows, 'amount'), count: sum(invoiceRows, 'count') },
    },
    // Money received: up-front invoice payments + collections, handed over or not.
    collected: {
      today: round2(sum(invoiceRows, 'paid', isToday) + sum(collectionRows, 'paid', isToday)),
      month: round2(sum(invoiceRows, 'paid') + sum(collectionRows, 'paid')),
    },
    daily: days.map((day) => ({
      day,
      sales: sum(invoiceRows, 'amount', (r) => r._id.day === day),
      collected: round2(
        sum(invoiceRows, 'paid', (r) => r._id.day === day) +
          sum(collectionRows, 'paid', (r) => r._id.day === day),
      ),
    })),
    visits: {
      today: Object.fromEntries(
        Object.values(VisitStatus).map((s) => [
          s,
          visitCount((v) => v._id.today && v._id.status === s),
        ]),
      ),
      monthCompleted: visitCount((v) => v._id.status === VisitStatus.COMPLETED),
      list: todayVisits,
    },
    customers: {
      total: customers?.total ?? 0,
      pendingApproval: customers?.pendingApproval ?? 0,
      debt: round2(customers?.debt ?? 0),
      debtors: customers?.debtors ?? 0,
      pendingPayments: round2(customers?.pendingPayments ?? 0),
      topDebtors,
    },
    cheques,
    recentInvoices,
  };

  if (!manager) {
    const [pending, custody] = await Promise.all([
      listPending(undefined, actor),
      StockModel.aggregate<{ items: number; quantity: number }>([
        { $match: { warehouse: null, rep: actor._id, quantity: { $gt: 0 } } },
        { $group: { _id: null, items: { $sum: 1 }, quantity: { $sum: '$quantity' } } },
      ]),
    ]);
    return {
      ...base,
      cashBox: { total: round2(pending.reduce((s, p) => s + p.amount, 0)), count: pending.length },
      custody: { items: custody[0]?.items ?? 0, quantity: custody[0]?.quantity ?? 0 },
    };
  }

  const [treasury, products, totals, reps] = await Promise.all([
    getSummary(),
    ProductModel.find({ isActive: true }).select('name unit minQuantity avgCost'),
    totalsByProduct(),
    UserModel.find({ role: UserRole.SALES_REP, isActive: true }).select('name').sort({ name: 1 }),
  ]);
  const qty = (id: string) => totals.get(id) ?? 0;
  const held = new Map(treasury.pendingByRep.map((p) => [p.rep.id, p.total]));
  const byRep = (id: string) => (r: Row) => String(r._id.rep) === id;

  return {
    ...base,
    treasury: {
      total: treasury.total,
      byMethod: treasury.byMethod,
      withReps: round2(treasury.pendingByRep.reduce((s, p) => s + p.total, 0)),
    },
    stock: {
      products: products.length,
      value: round2(products.reduce((s, p) => s + qty(p.id) * (p.avgCost ?? 0), 0)),
      lowStock: products
        .filter((p) => p.minQuantity != null && qty(p.id) <= p.minQuantity)
        .map((p) => ({
          id: p.id as string,
          name: p.name,
          unit: p.unit,
          quantity: qty(p.id),
          minQuantity: p.minQuantity,
        }))
        .sort((a, b) => a.quantity - b.quantity),
    },
    reps: reps.map((rep) => ({
      id: rep.id as string,
      name: rep.name,
      sales: sum(invoiceRows, 'amount', byRep(rep.id)),
      invoices: sum(invoiceRows, 'count', byRep(rep.id)),
      collected: round2(
        sum(invoiceRows, 'paid', byRep(rep.id)) + sum(collectionRows, 'paid', byRep(rep.id)),
      ),
      visitsCompleted: visitCount(
        (v) => String(v._id.rep) === rep.id && v._id.status === VisitStatus.COMPLETED,
      ),
      visitsToday: visitCount((v) => String(v._id.rep) === rep.id && v._id.today),
      cashHeld: held.get(rep.id) ?? 0,
    })),
  };
}
