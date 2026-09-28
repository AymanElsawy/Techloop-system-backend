import { InvoiceModel } from './invoice.model.js';
import { AttachmentKind, InvoiceStatus, PaymentMethod } from './invoice.types.js';
import type { CreateInvoiceInput, ListInvoicesFilters } from './invoice.validation.js';
import { getCollectableDebt, syncCustomerSummary } from '../customers/customer-balance.js';
import { DepositStatus } from '../treasury/treasury.types.js';
import { CustomerStatus } from '../customers/customer.types.js';
import { getCustomerById } from '../customers/customer.service.js';
import { ProductModel } from '../products/product.model.js';
import type { UserDocument } from '../users/user.model.js';
import { UserRole } from '../users/user.types.js';
import { AppError } from '../../utils/api-response.js';
import { assertLinkableVisit } from '../visits/visit.service.js';
import { logSale, returnSale, takeForSale } from '../inventory/inventory.service.js';
import { MovementType } from '../inventory/inventory.types.js';
import { ReturnModel, ReturnStatus } from '../returns/return.model.js';

const isManager = (actor: UserDocument) =>
  actor.role === UserRole.OWNER || actor.role === UserRole.ADMIN;

const round2 = (n: number) => Math.round(n * 100) / 100;

const withRefs = [
  { path: 'customer', select: 'name governorate city phone' },
  { path: 'createdBy cancelledBy attachments.uploadedBy', select: 'name' },
  { path: 'visit', select: 'purpose status scheduledAt' },
  { path: 'warehouse', select: 'name' },
  { path: 'deposit', select: 'number createdAt' },
];

/** Reps only see invoices they created. */
const visibility = (actor: UserDocument) => (isManager(actor) ? {} : { createdBy: actor._id });

// ponytail: no multi-document transaction (MongoDB runs standalone). Stock is taken
// first (put back if the invoice insert fails); customer summary follows. Run MongoDB as a replica set and
// wrap createInvoice/cancelInvoice in a session if partial writes ever become a problem.
export async function createInvoice(input: CreateInvoiceInput, actor: UserDocument) {
  const customer = await getCustomerById(input.customerId, actor);
  if (customer.status === CustomerStatus.REJECTED) {
    throw new AppError(400, 'Cannot invoice a rejected customer');
  }
  const visit = input.visitId
    ? await assertLinkableVisit(input.visitId, input.customerId, actor)
    : null;

  const productIds = input.items.map((i) => i.productId);
  const products = await ProductModel.find({ _id: { $in: productIds }, isActive: true });
  if (products.length !== productIds.length)
    throw new AppError(400, 'One or more products are not available');
  const byId = new Map(products.map((p) => [p.id as string, p]));

  // Prices come from the database, never from the client.
  const items = input.items.map(({ productId, quantity }) => {
    const p = byId.get(productId)!;
    return {
      product: p._id,
      name: p.name,
      unit: p.unit,
      unitPrice: p.price,
      quantity,
      total: round2(p.price * quantity),
    };
  });
  const total = round2(items.reduce((sum, i) => sum + i.total, 0));
  const paidAmount = round2(input.paidAmount);

  // Anything paid above the invoice total settles the customer's previous debt.
  // ponytail: debt check and insert are not atomic (same as collections).
  const previousDebt = await getCollectableDebt(customer._id);
  if (paidAmount > round2(total + previousDebt)) {
    throw new AppError(
      400,
      `Paid amount cannot exceed the invoice total plus the customer's previous debt (${round2(total + previousDebt)})`,
    );
  }

  const sale = await takeForSale(
    items.map((i) => ({ product: i.product, name: i.name, quantity: i.quantity })),
    input.warehouseId,
    actor,
  );
  items.forEach((item, idx) => Object.assign(item, { fromCustody: sale.items[idx]!.fromCustody }));

  const isCheque = paidAmount > 0 && input.paymentMethod === PaymentMethod.CHEQUE;
  const invoice = await InvoiceModel.create({
    invoiceNumber: input.invoiceNumber,
    customer: customer._id,
    createdBy: actor._id,
    visit: visit?._id ?? null,
    warehouse: sale.warehouse,
    rep: sale.rep,
    items,
    total,
    paidAmount,
    remaining: round2(Math.max(total - paidAmount, 0)),
    previousDebtPaid: round2(Math.max(paidAmount - total, 0)),
    paymentMethod: paidAmount > 0 ? input.paymentMethod : null,
    // Same as collections: a rep's up-front payment waits in their cash box until handover.
    depositStatus:
      paidAmount > 0 ? (isManager(actor) ? DepositStatus.DEPOSITED : DepositStatus.PENDING) : null,
    depositedAt: paidAmount > 0 && isManager(actor) ? new Date() : null,
    chequeNumber: isCheque ? (input.chequeNumber ?? null) : null,
    chequeDueDate: isCheque ? (input.chequeDueDate ?? null) : null,
    notes: input.notes || null,
  }).catch(async (err: unknown) => {
    await returnSale(sale);
    throw err;
  });

  await logSale(MovementType.SALE, { ...sale, invoice: invoice._id }, actor);
  await syncCustomerSummary(customer._id);
  return invoice.populate(withRefs);
}

export function listInvoices({ customerId, visitId }: ListInvoicesFilters, actor: UserDocument) {
  return InvoiceModel.find({
    ...visibility(actor),
    ...(customerId && { customer: customerId }),
    ...(visitId && { visit: visitId }),
  })
    .sort({ createdAt: -1 })
    .populate(withRefs);
}

export async function getInvoiceById(id: string, actor: UserDocument) {
  const invoice = await InvoiceModel.findOne({ _id: id, ...visibility(actor) }).populate(withRefs);
  if (!invoice) throw new AppError(404, 'Invoice not found');
  return invoice;
}

export async function cancelInvoice(id: string, reason: string, actor: UserDocument) {
  const invoice = await getInvoiceById(id, actor);
  if (invoice.status === InvoiceStatus.CANCELLED)
    throw new AppError(400, 'Invoice is already cancelled');
  if (await ReturnModel.exists({ invoice: invoice._id, status: ReturnStatus.ACTIVE }))
    throw new AppError(400, 'Cancel the returns of this invoice first');

  invoice.set({
    status: InvoiceStatus.CANCELLED,
    cancelReason: reason,
    cancelledBy: actor._id,
    cancelledAt: new Date(),
  });
  await invoice.save();
  const sale = {
    warehouse: invoice.warehouse._id,
    rep: invoice.rep ?? null,
    items: invoice.items.map((i) => ({
      product: i.product,
      name: i.name,
      quantity: i.quantity,
      fromCustody: i.fromCustody ?? 0,
    })),
  };
  await returnSale(sale);
  await logSale(MovementType.SALE_CANCEL, { ...sale, invoice: invoice._id }, actor);
  await syncCustomerSummary(invoice.customer._id);
  return invoice.populate(withRefs);
}

export async function addAttachment(
  id: string,
  kind: AttachmentKind,
  file: Express.Multer.File,
  actor: UserDocument,
) {
  const invoice = await getInvoiceById(id, actor);
  invoice.attachments.push({
    kind,
    fileName: file.filename,
    originalName: file.originalname,
    mimeType: file.mimetype,
    size: file.size,
    uploadedBy: actor._id,
  });
  await invoice.save();
  return invoice.populate(withRefs);
}

/** Returns the stored file info for an attachment the actor is allowed to see. */
export async function getAttachment(id: string, attachmentId: string, actor: UserDocument) {
  const invoice = await InvoiceModel.findOne({ _id: id, ...visibility(actor) });
  const attachment = invoice?.attachments.id(attachmentId);
  if (!attachment) throw new AppError(404, 'Attachment not found');
  return attachment;
}
