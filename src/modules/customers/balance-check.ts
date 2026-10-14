import { CustomerModel } from './customer.model.js';
import { getCustomerBalance, syncCustomerSummary } from './customer-balance.js';
import { SupplierModel } from '../suppliers/supplier.model.js';
import { getSupplierDebt, syncSupplierDebt } from '../suppliers/supplier-balance.js';
import { UserModel } from '../users/user.model.js';
import { UserRole } from '../users/user.types.js';
import { AuditAction, AuditEntity, audit } from '../audit/audit.service.js';
import { BALANCES_FIXED, notify } from '../notifications/notification.service.js';

const round2 = (n: number) => Math.round(n * 100) / 100;
const same = (a: number, b: number) => Math.abs(a - b) < 0.005;

/**
 * Stored balances are a cache, recomputed only when a customer / supplier has a new document.
 * After a change in how balances are computed, untouched ones keep the old number. This recomputes
 * every one from its documents, fixes what differs (logged in سجل العمليات as "السيستم"), and
 * tells the owners how many were fixed. Returns that count.
 */
export async function checkBalances() {
  let fixed = 0;

  const customers = await CustomerModel.find().select('name debit credit pendingPayments');
  for (const c of customers) {
    const { net, pending } = await getCustomerBalance(c._id);
    const stored = round2(c.debit - c.credit);
    if (same(stored, net) && same(c.pendingPayments, pending)) continue;
    await syncCustomerSummary(c._id);
    await audit(null, AuditAction.UPDATE, AuditEntity.CUSTOMER, {
      docId: c.id,
      title: c.name,
      reason: 'مراجعة الأرصدة: الرصيد المتخزن كان مختلف عن الحركات',
      before: { balance: stored, pendingPayments: c.pendingPayments },
      after: { balance: net, pendingPayments: pending },
    });
    fixed++;
  }

  const suppliers = await SupplierModel.find().select('name debt');
  for (const s of suppliers) {
    const debt = await getSupplierDebt(s._id);
    if (same(s.debt, debt)) continue;
    await syncSupplierDebt(s._id);
    await audit(null, AuditAction.UPDATE, AuditEntity.SUPPLIER, {
      docId: s.id,
      title: s.name,
      reason: 'مراجعة الأرصدة: الرصيد المتخزن كان مختلف عن الحركات',
      before: { debt: s.debt },
      after: { debt },
    });
    fixed++;
  }

  if (fixed) {
    // Owners only: the details are in سجل العمليات, which admins can't open.
    const owners = await UserModel.find({ role: UserRole.OWNER, isActive: true }).select('_id');
    for (const o of owners)
      await notify(
        { type: BALANCES_FIXED, docId: 'audit-log', number: null, quantity: fixed },
        null,
        o._id,
        false,
      );
  }
  return fixed;
}

/**
 * Once a minute after the server starts (a deploy is when the way of computing may have changed),
 * then every night at 3 AM server time.
 * ponytail: in-process timer like the backups; checks every hour, runs in the 3 AM hour.
 */
export function scheduleBalanceCheck() {
  const run = () =>
    checkBalances()
      .then((n) => n && console.log(`Balance check fixed ${n} balances.`))
      .catch((err: unknown) => console.error('Balance check failed', err));
  setTimeout(run, 60_000);
  setInterval(() => new Date().getHours() === 3 && run(), 60 * 60_000).unref();
}
