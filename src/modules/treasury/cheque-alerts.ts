import { InvoiceModel } from '../invoices/invoice.model.js';
import { InvoiceStatus, PaymentMethod } from '../invoices/invoice.types.js';
import { CollectionModel } from '../collections/collection.model.js';
import { CollectionStatus } from '../collections/collection.types.js';
import { SupplierPaymentModel } from '../suppliers/supplier-payment.model.js';
import { SupplierPaymentStatus } from '../suppliers/supplier-payment.types.js';
import { DepositStatus } from './treasury.types.js';
import {
  CHEQUE_DUE,
  SUPPLIER_CHEQUE_DUE,
  notify,
  wasNotified,
} from '../notifications/notification.service.js';

/** "بيوم أو اتنين": due today, tomorrow or the day after. */
const CHEQUE_WARNING_DAYS = 2;

/**
 * Tells managers once per cheque that its due date is near: cheques received from customers that
 * were not cashed or bounced yet (and the rep too while the cheque is still with them), and cheques
 * the company wrote to suppliers (so the bank has the money).
 */
async function checkCheques() {
  const start = new Date();
  start.setHours(0, 0, 0, 0); // same "today" as the dashboard's cheques card
  const due = {
    $gte: start,
    $lt: new Date(start.getTime() + (CHEQUE_WARNING_DAYS + 1) * 86_400_000),
  };
  const open = { paymentMethod: PaymentMethod.CHEQUE, chequeDueDate: due, chequeStatus: null };
  const customer = { path: 'customer', select: 'name' };
  const [invoices, collections, payments] = await Promise.all([
    InvoiceModel.find({ ...open, status: InvoiceStatus.ACTIVE, paidAmount: { $gt: 0 } }).populate(
      customer,
    ),
    CollectionModel.find({ ...open, status: CollectionStatus.ACTIVE }).populate(customer),
    SupplierPaymentModel.find({
      paymentMethod: PaymentMethod.CHEQUE,
      chequeDueDate: due,
      status: SupplierPaymentStatus.ACTIVE,
    }).populate({ path: 'supplier', select: 'name' }),
  ]);

  const received = [
    ...invoices.map((i) => ({ doc: i, amount: i.paidAmount })),
    ...collections.map((c) => ({ doc: c, amount: c.amount })),
  ];
  for (const { doc, amount } of received) {
    const number = doc.chequeNumber ?? null;
    const dueDate = doc.chequeDueDate!;
    if (await wasNotified(CHEQUE_DUE, doc.id as string, number, dueDate)) continue;
    const withRep = doc.depositStatus === DepositStatus.PENDING ? doc.createdBy : null;
    await notify(
      { type: CHEQUE_DUE, docId: doc.id, number, party: doc.customer, amount, dueDate },
      null,
      withRep,
    );
  }
  for (const p of payments) {
    const supplierId = String(p.supplier._id);
    const number = p.chequeNumber ?? null;
    // ponytail: keyed by supplier + cheque number + date; two unnumbered cheques to the same
    // supplier on the same day alert once.
    if (await wasNotified(SUPPLIER_CHEQUE_DUE, supplierId, number, p.chequeDueDate!)) continue;
    await notify(
      {
        type: SUPPLIER_CHEQUE_DUE,
        docId: supplierId,
        number,
        party: p.supplier,
        amount: p.amount,
        dueDate: p.chequeDueDate,
      },
      null,
    );
  }
}

// ponytail: in-process timer, same as the expiry alerts; an alert can show up to 6 hours late.
export function scheduleChequeAlerts() {
  const check = () =>
    checkCheques().catch((err: unknown) => console.error('Cheque alerts failed', err));
  setTimeout(check, 60_000); // let the server start first
  setInterval(check, 6 * 60 * 60_000).unref();
}
