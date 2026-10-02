import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import type { Model, Types } from 'mongoose';
import { CustomerModel } from '../customers/customer.model.js';
import { SupplierModel } from '../suppliers/supplier.model.js';
import { AppError } from '../../utils/api-response.js';
import { InvoiceModel } from '../invoices/invoice.model.js';
import { InvoiceStatus, PaymentMethod } from '../invoices/invoice.types.js';
import { CollectionModel } from '../collections/collection.model.js';
import { CollectionStatus } from '../collections/collection.types.js';
import { ReturnModel, ReturnStatus } from '../returns/return.model.js';
import { MovementModel } from '../inventory/inventory.model.js';
import { MovementType } from '../inventory/inventory.types.js';
import { SupplierPaymentModel } from '../suppliers/supplier-payment.model.js';
import { SupplierPaymentStatus } from '../suppliers/supplier-payment.types.js';
import { ChequeStatus, DepositStatus } from '../treasury/treasury.types.js';

/**
 * Public balance page (رابط المديونية): one fixed, unguessable link per customer / supplier that
 * shows their current balance outside the system and updates live (Server-Sent Events).
 */

/** Emits the customer / supplier id whenever its cached balance is recomputed. */
// ponytail: in-process emitter, so live updates only reach viewers on the same Node process; use Redis pub/sub if the backend ever runs as several instances.
export const balanceEvents = new EventEmitter().setMaxListeners(0);

/** The record's share token, created on first use and never changed afterwards. */
export async function ensureShareToken(
  model: Model<{ shareToken?: string | null }>,
  id: Types.ObjectId,
) {
  // Only fills an empty token, so two clicks at once still end up with the same link.
  await model.updateOne(
    { _id: id, shareToken: null },
    { shareToken: randomBytes(18).toString('base64url') },
  );
  const doc = await model.findById(id).select('shareToken');
  return { token: doc!.shareToken! };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const METHOD_LABELS: Record<PaymentMethod, string> = {
  [PaymentMethod.CASH]: 'كاش',
  [PaymentMethod.VODAFONE_CASH]: 'فودافون كاش',
  [PaymentMethod.BANK_TRANSFER]: 'تحويل بنكي',
  [PaymentMethod.CHEQUE]: 'شيك',
};

/** One row of the public table: a purchase, a payment (سداد) or returned goods. Cancelled entries are left out. */
type Line = {
  date: Date;
  kind: 'purchase' | 'payment' | 'return';
  items: { name: string; quantity: number; price: number; total: number }[];
  total: number | null;
  paid: number | null;
  remaining: number | null;
  note: string | null;
};

type Paid = {
  depositStatus?: string | null;
  chequeStatus?: string | null;
  paymentMethod?: string | null;
};
const paidNote = (p: Paid) =>
  p.chequeStatus === ChequeStatus.BOUNCED
    ? 'شيك مرتجع، متحسبش'
    : p.depositStatus === DepositStatus.PENDING
      ? 'مع المندوب، بيتخصم لما يتسلم للخزنة'
      : null;
const method = (p: Paid) =>
  p.paymentMethod ? METHOD_LABELS[p.paymentMethod as PaymentMethod] : null;

// ponytail: newest 200 rows only, so the page and every live update stay small; add paging if someone needs older history.
const MAX_LINES = 200;
const newestFirst = (lines: Line[]) =>
  lines.sort((a, b) => b.date.getTime() - a.date.getTime()).slice(0, MAX_LINES);

async function customerLines(customer: Types.ObjectId) {
  const [invoices, collections, returns] = await Promise.all([
    InvoiceModel.find({ customer, status: InvoiceStatus.ACTIVE })
      .sort({ createdAt: -1 })
      .limit(MAX_LINES),
    CollectionModel.find({ customer, status: CollectionStatus.ACTIVE })
      .sort({ createdAt: -1 })
      .limit(MAX_LINES),
    ReturnModel.find({ customer, status: ReturnStatus.ACTIVE })
      .sort({ createdAt: -1 })
      .limit(MAX_LINES),
  ]);
  const lines: Line[] = [];
  for (const inv of invoices) {
    // Money paid above the invoice total settles older debt: shown as its own سداد row.
    const oldDebt = inv.previousDebtPaid ?? 0;
    lines.push({
      date: inv.createdAt,
      kind: 'purchase',
      items: inv.items.map((i) => ({
        name: i.name,
        quantity: i.quantity,
        price: i.unitPrice,
        total: i.total,
      })),
      total: inv.total,
      paid: round2(inv.paidAmount - oldDebt),
      remaining: inv.remaining,
      note: inv.paidAmount > 0 ? paidNote(inv) : null,
    });
    if (oldDebt > 0)
      lines.push({
        date: inv.createdAt,
        kind: 'payment',
        items: [],
        total: null,
        paid: oldDebt,
        remaining: null,
        note: [method(inv), paidNote(inv) ?? 'من مديونية قديمة'].filter(Boolean).join(' · '),
      });
  }
  for (const col of collections)
    lines.push({
      date: col.createdAt,
      kind: 'payment',
      items: [],
      total: null,
      paid: col.amount,
      remaining: null,
      note: [method(col), paidNote(col)].filter(Boolean).join(' · ') || null,
    });
  for (const r of returns)
    lines.push({
      date: r.createdAt,
      kind: 'return',
      items: r.items.map((i) => ({
        name: i.name,
        quantity: i.quantity,
        price: i.unitPrice,
        total: i.total,
      })),
      total: r.total,
      paid: null,
      remaining: null,
      note: null,
    });
  return newestFirst(lines);
}

async function supplierLines(supplier: Types.ObjectId) {
  const [receipts, payments] = await Promise.all([
    MovementModel.find({ type: MovementType.RECEIVE, supplier })
      .sort({ createdAt: -1 })
      .limit(MAX_LINES),
    SupplierPaymentModel.find({ supplier, status: SupplierPaymentStatus.ACTIVE })
      .sort({ createdAt: -1 })
      .limit(MAX_LINES),
  ]);
  const lines: Line[] = receipts.map((m) => {
    const items = m.items.map((i) => ({
      name: i.name,
      quantity: i.quantity,
      price: i.unitCost ?? 0,
      total: round2(i.quantity * (i.unitCost ?? 0)),
    }));
    const total = m.totalCost ?? round2(items.reduce((sum, i) => sum + i.total, 0));
    // Old receipts without paidAmount count as fully paid, same as getSupplierDebt().
    const paid = m.paidAmount ?? total;
    return {
      date: m.createdAt,
      kind: 'purchase',
      items,
      total,
      paid,
      remaining: round2(Math.max(total - paid, 0)),
      note: null,
    };
  });
  for (const p of payments)
    lines.push({
      date: p.createdAt,
      kind: 'payment',
      items: [],
      total: null,
      paid: p.amount,
      remaining: null,
      note: method(p),
    });
  return newestFirst(lines);
}

/** From the company's books: debit = they owe the company, credit = the company owes them. */
async function findByToken(token: string) {
  const [customer, supplier] = await Promise.all([
    CustomerModel.findOne({ shareToken: token }),
    SupplierModel.findOne({ shareToken: token }),
  ]);
  if (customer)
    return {
      id: String(customer._id),
      data: {
        name: customer.name,
        debit: customer.debit,
        credit: customer.credit,
        pending: customer.pendingPayments,
        updatedAt: customer.updatedAt,
        lines: await customerLines(customer._id),
      },
    };
  if (supplier)
    return {
      id: String(supplier._id),
      data: {
        name: supplier.name,
        debit: 0,
        credit: supplier.debt,
        pending: 0,
        updatedAt: supplier.updatedAt,
        lines: await supplierLines(supplier._id),
      },
    };
  throw new AppError(404, 'Link not found');
}

export const publicRoutes = Router();

publicRoutes.get('/s/:token', async (req, res) => {
  const { token } = req.params;
  const [c, s] = await Promise.all([
    CustomerModel.exists({ shareToken: token }),
    SupplierModel.exists({ shareToken: token }),
  ]);
  if (!c && !s) throw new AppError(404, 'Link not found');
  const nonce = randomBytes(16).toString('base64');
  res
    .set(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'`,
    )
    .set('Cache-Control', 'no-store')
    .type('html')
    .send(PAGE.replace('__NONCE__', nonce));
});

publicRoutes.get('/s/:token/events', async (req, res) => {
  const { id, data } = await findByToken(req.params.token);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // nginx: don't buffer the stream
  });
  const send = (d: unknown) => res.write(`data: ${JSON.stringify(d)}\n\n`);
  send(data);

  const onChange = (changedId: string) => {
    if (changedId !== id) return;
    findByToken(req.params.token).then(
      (next) => send(next.data),
      () => res.end(), // token gone
    );
  };
  balanceEvents.on('change', onChange);
  const ping = setInterval(() => res.write(':\n\n'), 25_000); // keeps proxies from closing it
  req.on('close', () => {
    balanceEvents.off('change', onChange);
    clearInterval(ping);
  });
});

const PAGE = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>كشف المديونية | Techloop Pharma</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; grid-template-columns: minmax(0, 1fr); justify-items: center; align-content: start; gap: 16px; padding: 16px; box-sizing: border-box;
         font-family: system-ui, -apple-system, "Segoe UI", Tahoma, sans-serif; background: #111c22; color: #e8f1f2; }
  .card { width: 100%; max-width: 760px; box-sizing: border-box; background: #233843; border-radius: 16px; padding: 28px 24px; text-align: center; }
  .brand { font-size: 13px; color: #9abbcb; margin: 0 0 18px; }
  h1 { font-size: 22px; margin: 0 0 24px; }
  .label { font-size: 15px; margin: 0; color: #9abbcb; }
  .amount { font-size: 36px; font-weight: 700; margin: 8px 0 4px; font-variant-numeric: tabular-nums; }
  .debit { color: #ff8a7a; } .credit { color: #7ad7a8; }
  .note { font-size: 13px; color: #f3c58a; margin: 14px 0 0; }
  .meta { font-size: 12px; color: #9abbcb; margin: 22px 0 0; }
  .live { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #7ad7a8; margin-inline-end: 6px; }
  .off .live { background: #ff8a7a; }
  h2 { font-size: 16px; margin: 0 0 12px; text-align: start; }
  .scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; text-align: start; }
  th { color: #9abbcb; font-weight: 600; padding: 8px 6px; border-bottom: 1px solid #345565; white-space: nowrap; text-align: start; }
  td { padding: 10px 6px; border-bottom: 1px solid #2c4552; vertical-align: top; }
  td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .tag { display: inline-block; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 999px; margin-bottom: 4px; }
  .tag.purchase { background: #345565; } .tag.payment { background: #1f5a43; color: #b6f0d2; } .tag.return { background: #5a4a1f; color: #f3c58a; }
  tr.payment td { background: rgba(122, 215, 168, 0.08); }
  .item { color: #bcd1dc; min-width: 160px; }
  .small { font-size: 11px; color: #f3c58a; }
  .empty { color: #9abbcb; font-size: 13px; text-align: center; margin: 12px 0; }
</style>
</head>
<body>
<main class="card">
  <p class="brand">Techloop Pharma</p>
  <h1 id="name">...</h1>
  <p class="label" id="label">جاري التحميل...</p>
  <p class="amount" id="amount"></p>
  <p class="note" id="note" hidden></p>
  <p class="meta" id="meta"><span class="live"></span><span id="status">متصل، بيتحدث تلقائي</span></p>
</main>
<section class="card">
  <h2>الحركات</h2>
  <div class="scroll">
    <table>
      <thead><tr><th>التاريخ</th><th>البيان</th><th>الإجمالي</th><th>المدفوع</th><th>الباقي</th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
  </div>
  <p class="empty" id="empty" hidden>مفيش حركات لسه.</p>
</section>
<script nonce="__NONCE__">
  const $ = (id) => document.getElementById(id);
  const money = (n) => n.toLocaleString('ar-EG', { maximumFractionDigits: 2 }) + ' ج.م';
  const es = new EventSource(location.pathname.replace(/\\/$/, '') + '/events');
  es.onmessage = (e) => {
    const d = JSON.parse(e.data);
    $('name').textContent = d.name;
    const amount = $('amount');
    if (d.debit > 0) {
      $('label').textContent = 'مدين (مستحق عليكم)';
      amount.textContent = money(d.debit);
      amount.className = 'amount debit';
    } else if (d.credit > 0) {
      $('label').textContent = 'دائن (مستحق لكم)';
      amount.textContent = money(d.credit);
      amount.className = 'amount credit';
    } else {
      $('label').textContent = 'الحساب مسدد بالكامل';
      amount.textContent = money(0);
      amount.className = 'amount';
    }
    $('note').hidden = !(d.pending > 0);
    $('note').textContent = d.pending > 0 ? 'مبلغ ' + money(d.pending) + ' مدفوع للمندوب وهيتخصم أول ما يتسلم للخزنة.' : '';
    $('status').textContent = 'متصل، بيتحدث تلقائي · آخر تعديل ' +
      new Date(d.updatedAt).toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' });
    renderLines(d.lines);
    document.body.classList.remove('off');
  };
  const TAGS = { purchase: 'شراء', payment: 'سداد', return: 'مرتجع' };
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const num = (n) => el('td', 'num', n == null ? '—' : money(n));
  function renderLines(lines) {
    const rows = $('rows');
    rows.replaceChildren(...lines.map((l) => {
      const tr = el('tr', l.kind);
      tr.append(el('td', 'num', new Date(l.date).toLocaleDateString('ar-EG', { dateStyle: 'medium' })));
      const what = el('td');
      what.append(el('span', 'tag ' + l.kind, TAGS[l.kind]));
      for (const i of l.items)
        what.append(el('div', 'item', i.name + ' — ' + i.quantity.toLocaleString('ar-EG') + ' × ' + money(i.price)));
      if (l.note) what.append(el('div', 'small', l.note));
      tr.append(what, num(l.kind === 'return' ? -l.total : l.total), num(l.paid), num(l.remaining));
      return tr;
    }));
    $('empty').hidden = lines.length > 0;
  }
  es.onerror = () => {
    document.body.classList.add('off');
    $('status').textContent = 'انقطع الاتصال، بنحاول نتصل تاني...';
  };
</script>
</body>
</html>`;
