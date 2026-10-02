import { Router, type Response } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth.middleware.js';
import { authorize } from '../../middleware/role.middleware.js';
import { ok } from '../../utils/api-response.js';
import { UserRole } from '../users/user.types.js';
import { AGING_BUCKETS, agingReport, purchasesReport, salesReport } from './report.service.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const isoDay = (d: Date) => d.toLocaleDateString('en-CA'); // YYYY-MM-DD, server time zone
const format = z.enum(['json', 'csv']).default('json');

const salesSchema = z.object({
  groupBy: z.enum(['product', 'governorate', 'rep']).default('product'),
  // Default: this month up to today.
  from: day.default(() => {
    const now = new Date();
    return isoDay(new Date(now.getFullYear(), now.getMonth(), 1));
  }),
  to: day.default(() => isoDay(new Date())),
  format,
});

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
