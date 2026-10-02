import { Types } from 'mongoose';
import { UserModel } from './user.model.js';
import { UserRole } from './user.types.js';
import { InvoiceModel } from '../invoices/invoice.model.js';
import { InvoiceStatus } from '../invoices/invoice.types.js';
import { CollectionModel } from '../collections/collection.model.js';
import { CollectionStatus } from '../collections/collection.types.js';
import { ReturnModel, ReturnStatus } from '../returns/return.model.js';
import { ChequeStatus } from '../treasury/treasury.types.js';
import { AppError } from '../../utils/api-response.js';

const round2 = (n: number) => Math.round(n * 100) / 100;
const progress = (value: number, target: number | null | undefined) =>
  target ? Math.round((value / target) * 100) : null;

type Total = { _id: Types.ObjectId | null; total: number };
const byId = (rows: Total[]) => new Map(rows.map((r) => [String(r._id), r.total]));

/** A month (YYYY-MM) or a year (YYYY); neither = this month. */
export type Period = { month?: string; year?: string };

/** The period's key and createdAt range, in the server's time zone. */
function periodRange({ month, year }: Period) {
  const now = new Date();
  if (year) {
    const y = Number(year);
    return {
      period: 'YEAR' as const,
      key: year,
      createdAt: { $gte: new Date(y, 0, 1), $lt: new Date(y + 1, 0, 1) },
    };
  }
  const [y, m] = month ? month.split('-').map(Number) : [now.getFullYear(), now.getMonth() + 1];
  return {
    period: 'MONTH' as const,
    key: `${y}-${String(m).padStart(2, '0')}`,
    createdAt: { $gte: new Date(y, m - 1, 1), $lt: new Date(y, m, 1) },
  };
}

/**
 * Each sales rep's month (or year) against their monthly (or yearly) targets, and the commission it earns.
 * Net sales = active invoices − active returns on the rep's invoices.
 * Collected = up-front invoice payments + collections, bounced cheques excluded.
 * Days follow the server's time zone, same as the dashboard.
 */
export async function targetReport(range: Period = {}, repId?: string) {
  const { period, key, createdAt } = periodRange(range);
  const yearly = period === 'YEAR';
  const notBounced = (field: string) => ({
    $cond: [{ $eq: ['$chequeStatus', ChequeStatus.BOUNCED] }, 0, `$${field}`],
  });

  const [reps, invoices, paid, collections, returns] = await Promise.all([
    UserModel.find({ role: UserRole.SALES_REP, ...(repId && { _id: repId }) }).sort({ name: 1 }),
    InvoiceModel.aggregate<Total>([
      { $match: { status: InvoiceStatus.ACTIVE, createdAt } },
      { $group: { _id: '$createdBy', total: { $sum: '$total' } } },
    ]),
    InvoiceModel.aggregate<Total>([
      { $match: { status: InvoiceStatus.ACTIVE, createdAt } },
      { $group: { _id: '$createdBy', total: { $sum: notBounced('paidAmount') } } },
    ]),
    CollectionModel.aggregate<Total>([
      { $match: { status: CollectionStatus.ACTIVE, createdAt } },
      { $group: { _id: '$createdBy', total: { $sum: notBounced('amount') } } },
    ]),
    ReturnModel.aggregate<Total>([
      { $match: { status: ReturnStatus.ACTIVE, createdAt } },
      {
        $lookup: {
          from: InvoiceModel.collection.name,
          localField: 'invoice',
          foreignField: '_id',
          as: 'inv',
          pipeline: [{ $project: { createdBy: 1 } }],
        },
      },
      { $group: { _id: { $first: '$inv.createdBy' }, total: { $sum: '$total' } } },
    ]),
  ]);
  const [salesBy, paidBy, collectedBy, returnsBy] = [invoices, paid, collections, returns].map(
    byId,
  );

  return {
    period,
    key,
    reps: reps
      .map((rep) => {
        const salesGoal = (yearly ? rep.yearlySalesTarget : rep.salesTarget) ?? null;
        const collectionGoal = (yearly ? rep.yearlyCollectionTarget : rep.collectionTarget) ?? null;
        const sales = round2(salesBy.get(rep.id) ?? 0);
        const returned = round2(returnsBy.get(rep.id) ?? 0);
        const netSales = round2(sales - returned);
        const collected = round2((paidBy.get(rep.id) ?? 0) + (collectedBy.get(rep.id) ?? 0));
        const salesCommission = round2((netSales * rep.salesCommissionRate) / 100);
        const collectionCommission = round2((collected * rep.collectionCommissionRate) / 100);
        return {
          id: rep.id as string,
          name: rep.name,
          isActive: rep.isActive,
          salesTarget: rep.salesTarget ?? null,
          collectionTarget: rep.collectionTarget ?? null,
          yearlySalesTarget: rep.yearlySalesTarget ?? null,
          yearlyCollectionTarget: rep.yearlyCollectionTarget ?? null,
          salesGoal,
          collectionGoal,
          salesCommissionRate: rep.salesCommissionRate,
          collectionCommissionRate: rep.collectionCommissionRate,
          sales,
          returns: returned,
          netSales,
          collected,
          salesProgress: progress(netSales, salesGoal),
          collectionProgress: progress(collected, collectionGoal),
          salesCommission,
          collectionCommission,
          commission: round2(salesCommission + collectionCommission),
        };
      })
      // Stopped reps only show up for periods they worked in.
      .filter((r) => repId || r.isActive || r.sales || r.returns || r.collected),
  };
}

/** One rep's month (or year): the summary row + the invoices, returns and collections behind it. */
export async function repTargetReport(repId: string, range: Period = {}) {
  if (!Types.ObjectId.isValid(repId)) throw new AppError(404, 'Sales rep not found');
  const { period, key, createdAt } = periodRange(range);
  const [report, invoices, collections, returns] = await Promise.all([
    targetReport(range, repId),
    InvoiceModel.find({ createdBy: repId, status: InvoiceStatus.ACTIVE, createdAt })
      .sort({ createdAt: 1 })
      .select('invoiceNumber customer total paidAmount paymentMethod chequeStatus createdAt')
      .populate({ path: 'customer', select: 'name' }),
    CollectionModel.find({ createdBy: repId, status: CollectionStatus.ACTIVE, createdAt })
      .sort({ createdAt: 1 })
      .select('receiptNumber customer amount paymentMethod chequeNumber chequeStatus createdAt')
      .populate({ path: 'customer', select: 'name' }),
    // Returns count for the rep who made the invoice, not whoever recorded the return.
    ReturnModel.find({ status: ReturnStatus.ACTIVE, createdAt })
      .sort({ createdAt: 1 })
      .select('number invoice customer total createdAt')
      .populate([
        { path: 'invoice', select: 'invoiceNumber createdBy' },
        { path: 'customer', select: 'name' },
      ]),
  ]);
  const rep = report.reps[0];
  if (!rep) throw new AppError(404, 'Sales rep not found');
  return {
    period,
    key,
    rep,
    invoices,
    collections,
    returns: returns.filter(
      (r) => String((r.invoice as unknown as { createdBy: Types.ObjectId }).createdBy) === repId,
    ),
  };
}
