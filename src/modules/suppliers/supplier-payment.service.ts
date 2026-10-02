import { SupplierPaymentModel } from './supplier-payment.model.js';
import { SupplierPaymentStatus } from './supplier-payment.types.js';
import { findActiveSupplier, findSupplier } from './supplier.service.js';
import { getSupplierDebt, syncSupplierDebt } from './supplier-balance.js';
import type { CreateSupplierPaymentInput } from './supplier-payment.validation.js';
import { PaymentMethod } from '../invoices/invoice.types.js';
import type { UserDocument } from '../users/user.model.js';
import { AppError } from '../../utils/api-response.js';
import { SUPPLIER_PAYMENT, notify } from '../notifications/notification.service.js';

const round2 = (n: number) => Math.round(n * 100) / 100;

const withRefs = [{ path: 'createdBy cancelledBy', select: 'name' }];

// ponytail: max+1 per model, same as movement numbers; a counter doc would help if it matters.
async function nextPaymentNumber() {
  const last = await SupplierPaymentModel.findOne().sort({ number: -1 }).select('number');
  return (last?.number ?? 0) + 1;
}

export async function createPayment(
  supplierId: string,
  input: CreateSupplierPaymentInput,
  actor: UserDocument,
) {
  const supplier = await findActiveSupplier(supplierId);
  const amount = round2(input.amount);

  const debt = await getSupplierDebt(supplier._id);
  if (amount > debt) throw new AppError(400, `Amount exceeds the supplier's debt (${debt})`);

  const isCheque = input.paymentMethod === PaymentMethod.CHEQUE;
  const payment = await SupplierPaymentModel.create({
    number: await nextPaymentNumber(),
    supplier: supplier._id,
    createdBy: actor._id,
    amount,
    paymentMethod: input.paymentMethod,
    chequeNumber: isCheque ? (input.chequeNumber ?? null) : null,
    chequeDueDate: isCheque ? (input.chequeDueDate ?? null) : null,
    notes: input.notes || null,
  });

  await syncSupplierDebt(supplier._id);
  await notify(
    { type: SUPPLIER_PAYMENT, docId: supplier.id, number: payment.number, party: supplier, amount },
    actor,
  );
  return payment.populate(withRefs);
}

export function listPayments(supplierId: string) {
  return SupplierPaymentModel.find({ supplier: supplierId })
    .sort({ createdAt: -1 })
    .populate(withRefs);
}

export async function cancelPayment(paymentId: string, reason: string, actor: UserDocument) {
  const payment = await SupplierPaymentModel.findById(paymentId);
  if (!payment) throw new AppError(404, 'Payment not found');
  if (payment.status === SupplierPaymentStatus.CANCELLED)
    throw new AppError(400, 'Payment is already cancelled');

  payment.set({
    status: SupplierPaymentStatus.CANCELLED,
    cancelReason: reason,
    cancelledBy: actor._id,
    cancelledAt: new Date(),
  });
  await payment.save();
  await syncSupplierDebt(payment.supplier);
  await notify(
    {
      type: SUPPLIER_PAYMENT,
      cancelled: true,
      docId: payment.supplier,
      number: payment.number,
      party: await findSupplier(payment.supplier),
      amount: payment.amount,
    },
    actor,
  );
  return payment.populate(withRefs);
}
