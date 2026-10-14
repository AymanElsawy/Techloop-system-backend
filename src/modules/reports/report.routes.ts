import { Router, type Response } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth.middleware.js';
import { authorize } from '../../middleware/role.middleware.js';
import { ok } from '../../utils/api-response.js';
import { UserRole } from '../users/user.types.js';
import { AGING_BUCKETS, agingReport, purchasesReport, salesReport } from './report.service.js';
import {
  customerReport,
  customersReport,
  supplierReport,
  suppliersReport,
  type Line,
} from './party-reports.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const isoDay = (d: Date) => d.toLocaleDateString('en-CA'); // YYYY-MM-DD, server time zone
const format = z.enum(['json', 'csv']).default('json');

// Default: this month up to today.
const periodSchema = z.object({
  from: day.default(() => {
    const now = new Date();
    return isoDay(new Date(now.getFullYear(), now.getMonth(), 1));
  }),
  to: day.default(() => isoDay(new Date())),
  format,
});
const salesSchema = periodSchema.extend({
  groupBy: z.enum(['product', 'governorate', 'rep']).default('product'),
});
const range = (q: { from: string; to: string }) =>
  [new Date(`${q.from}T00:00:00`), new Date(`${q.to}T23:59:59.999`)] as const;

/** CSV with a BOM so Excel opens Arabic text correctly. */
function sendCsv(res: Response, filename: string, header: string[], rows: unknown[][]) {
  const cell = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('﻿' + body);
}

const GROUP_LABELS = { product: 'الصنف', governorate: 'المحافظة', rep: 'المندوب' };

export const reportRoutes = Router();

reportRoutes.use(authenticate, authorize(UserRole.OWNER, UserRole.ADMIN));

reportRoutes.get('/sales', async (req, res) => {
  const q = salesSchema.parse(req.query);
  const report = await salesReport(
    q.groupBy,
    new Date(`${q.from}T00:00:00`),
    new Date(`${q.to}T23:59:59.999`),
  );
  if (q.format === 'json') return ok(res, { ...q, ...report });
  const t = report.totals;
  sendCsv(
    res,
    `sales-${q.groupBy}-${q.from}_${q.to}.csv`,
    [
      GROUP_LABELS[q.groupBy],
      'الكمية (صافي)',
      'عدد الفواتير',
      'المبيعات',
      'المرتجعات',
      'صافي المبيعات',
      'التكلفة',
      'الربح',
      'ملاحظة',
    ],
    [
      ...report.rows.map((r) => [
        r.name,
        r.quantity,
        r.invoices,
        r.sales,
        r.returns,
        r.net,
        r.cost,
        r.profit,
        r.costMissing ? 'فيه أصناف من غير سعر شراء' : '',
      ]),
      ['الإجمالي', '', t.invoices, t.sales, t.returns, t.net, t.cost, t.profit, ''],
    ],
  );
});

reportRoutes.get('/aging', async (req, res) => {
  const q = z.object({ format }).parse(req.query);
  const report = await agingReport();
  if (q.format === 'json') return ok(res, report);
  const t = report.totals;
  sendCsv(
    res,
    `aging-${isoDay(new Date())}.csv`,
    [
      'العميل',
      'المحافظة',
      'الهاتف',
      'المديونية',
      'تحت التسليم',
      ...AGING_BUCKETS.map((b, i) => (i === 0 ? b : `متأخر ${b} يوم`)),
      'أقدم تأخير (يوم)',
    ],
    [
      ...report.rows.map((r) => [
        r.customer.name,
        r.customer.governorate,
        r.customer.phone,
        r.debt,
        r.pending,
        ...r.buckets,
        r.oldestDays,
      ]),
      ['الإجمالي', '', '', t.debt, t.pending, ...t.buckets, ''],
    ],
  );
});

// No dates = all purchases ever.
const purchasesSchema = z.object({ from: day.optional(), to: day.optional(), format });

reportRoutes.get('/purchases', async (req, res) => {
  const q = purchasesSchema.parse(req.query);
  const report = await purchasesReport(
    q.from ? new Date(`${q.from}T00:00:00`) : undefined,
    q.to ? new Date(`${q.to}T23:59:59.999`) : undefined,
  );
  if (q.format === 'json') return ok(res, { from: q.from ?? null, to: q.to ?? null, ...report });
  sendCsv(
    res,
    `purchases-${q.from ?? 'all'}_${q.to ?? isoDay(new Date())}.csv`,
    [
      'الصنف',
      'المورد',
      'عدد مرات الشراء',
      'الكمية',
      'الإجمالي',
      'متوسط السعر',
      'أقل سعر',
      'أعلى سعر',
      'آخر سعر',
      'آخر شراء',
      'متوسط الصنف الحالي',
    ],
    [
      ...report.rows.map((r) => [
        r.product.name,
        r.supplier.name,
        r.receipts,
        r.quantity,
        r.total,
        r.avgCost,
        r.minCost,
        r.maxCost,
        r.lastCost,
        isoDay(r.lastAt),
        r.currentAvgCost,
      ]),
      ['الإجمالي', '', '', report.totals.quantity, report.totals.total, '', '', '', '', '', ''],
    ],
  );
});

// ---------- customers / suppliers ----------

const METHOD_LABELS: Record<string, string> = {
  CASH: 'نقدي',
  VODAFONE_CASH: 'فودافون كاش',
  BANK_TRANSFER: 'تحويل بنكي',
  CHEQUE: 'شيك',
};
const LINE_LABELS: Record<Line['kind'], string> = {
  invoice: 'فاتورة بيع',
  return: 'مرتجع',
  collection: 'تحصيل',
  receipt: 'وارد',
  payment: 'دفعة',
};

/**
 * A customer / supplier report as CSV, like كشف الحساب: a title row, the opening balance,
 * every document oldest first with the running balance, then totals and the closing balance.
 */
function sendStatement(
  res: Response,
  filename: string,
  title: string,
  [debitLabel, creditLabel]: [string, string],
  r: { opening: number; closing: number; lines: Line[] },
) {
  sendCsv(
    res,
    filename,
    ['التاريخ', 'المستند', 'الرقم', debitLabel, creditLabel, 'الرصيد', 'طريقة الدفع', 'ملاحظة'],
    [
      [title, '', '', '', '', '', '', ''],
      ['', 'رصيد أول المدة', '', '', '', r.opening, '', ''],
      ...r.lines.map((l) => [
        isoDay(l.date),
        LINE_LABELS[l.kind],
        l.number,
        l.debit || '',
        l.credit || '',
        l.balance,
        l.method ? METHOD_LABELS[l.method] : l.kind === 'invoice' ? 'آجل' : '',
        l.bounced ? 'شيك مرتد (مش محسوب)' : l.pending ? 'مع المندوب' : '',
      ]),
      [
        '',
        'الإجمالي',
        '',
        round2(r.lines.reduce((s, l) => s + l.debit, 0)),
        round2(r.lines.reduce((s, l) => s + l.credit, 0)),
        '',
        '',
        '',
      ],
      ['', 'رصيد آخر المدة', '', '', '', r.closing, '', ''],
    ],
  );
}
const round2 = (n: number) => Math.round(n * 100) / 100;

reportRoutes.get('/customers', async (req, res) => {
  const q = periodSchema.parse(req.query);
  const report = await customersReport(...range(q));
  if (q.format === 'json') return ok(res, { from: q.from, to: q.to, ...report });
  const t = report.totals;
  sendCsv(
    res,
    `customers-${q.from}_${q.to}.csv`,
    ['العميل', 'المحافظة', 'عدد الفواتير', 'المبيعات', 'المرتجعات', 'الصافي', 'الربح', 'المحصّل', 'الرصيد الحالي'],
    [
      ...report.rows.map((r) => [
        r.customer.name,
        r.customer.governorate,
        r.invoices,
        r.sales,
        r.returns,
        r.net,
        r.profit,
        r.collected,
        r.balance,
      ]),
      ['الإجمالي', '', t.invoices, t.sales, t.returns, t.net, t.profit, t.collected, t.balance],
    ],
  );
});

reportRoutes.get('/customers/:id', async (req, res) => {
  const q = periodSchema.parse(req.query);
  const report = await customerReport(req.params.id, ...range(q));
  if (q.format === 'json') return ok(res, { from: q.from, to: q.to, ...report });
  sendStatement(
    res,
    `customer-${q.from}_${q.to}.csv`,
    `كشف حساب ${report.customer.name} · من ${q.from} إلى ${q.to}`,
    ['مدين (عليه)', 'دائن (له)'],
    report,
  );
});

reportRoutes.get('/suppliers', async (req, res) => {
  const q = periodSchema.parse(req.query);
  const report = await suppliersReport(...range(q));
  if (q.format === 'json') return ok(res, { from: q.from, to: q.to, ...report });
  const t = report.totals;
  sendCsv(
    res,
    `suppliers-${q.from}_${q.to}.csv`,
    ['المورد', 'الهاتف', 'مرات التوريد', 'المشتريات', 'المدفوع', 'المديونية الحالية'],
    [
      ...report.rows.map((r) => [
        r.supplier.name,
        r.supplier.phone,
        r.receipts,
        r.purchases,
        r.paid,
        r.debt,
      ]),
      ['الإجمالي', '', t.receipts, t.purchases, t.paid, t.debt],
    ],
  );
});

reportRoutes.get('/suppliers/:id', async (req, res) => {
  const q = periodSchema.parse(req.query);
  const report = await supplierReport(req.params.id, ...range(q));
  if (q.format === 'json') return ok(res, { from: q.from, to: q.to, ...report });
  sendStatement(
    res,
    `supplier-${q.from}_${q.to}.csv`,
    `كشف حساب ${report.supplier.name} · من ${q.from} إلى ${q.to}`,
    ['المشتريات (له)', 'المدفوع (عليه)'],
    report,
  );
});
