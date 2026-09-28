import { CollectionModel } from './collection.model.js';
import { CollectionStatus } from './collection.types.js';
import type { CreateCollectionInput, ListCollectionsFilters } from './collection.validation.js';
import { getCustomerById } from '../customers/customer.service.js';
import { getCollectableDebt, syncCustomerSummary } from '../customers/customer-balance.js';
import { DepositStatus } from '../treasury/treasury.types.js';
import { AttachmentKind, PaymentMethod } from '../invoices/invoice.types.js';
import type { UserDocument } from '../users/user.model.js';
import { UserRole } from '../users/user.types.js';
import { AppError } from '../../utils/api-response.js';
import { assertLinkableVisit } from '../visits/visit.service.js';

const isManager = (actor: UserDocument) =>
  actor.role === UserRole.OWNER || actor.role === UserRole.ADMIN;

const round2 = (n: number) => Math.round(n * 100) / 100;

const withRefs = [
  { path: 'customer', select: 'name governorate city phone' },
  { path: 'createdBy cancelledBy attachments.uploadedBy', select: 'name' },
  { path: 'visit', select: 'purpose status scheduledAt' },
  { path: 'deposit', select: 'number createdAt' },
];

/** Reps only see collections they created. */
const visibility = (actor: UserDocument) => (isManager(actor) ? {} : { createdBy: actor._id });

// ponytail: the debt check and insert are not atomic; two simultaneous collections for the
// same customer could together exceed the debt. Fine at current volume; lock per customer if needed.
export async function createCollection(input: CreateCollectionInput, actor: UserDocument) {
  const customer = await getCustomerById(input.customerId, actor);
  const visit = input.visitId
    ? await assertLinkableVisit(input.visitId, input.customerId, actor)
    : null;
  const amount = round2(input.amount);

  // Money already collected but not handed over is excluded, so it can't be collected twice.
  const debt = await getCollectableDebt(customer._id);
  if (amount > debt) {
    throw new AppError(400, `Amount exceeds the customer's debt (${debt})`);
  }

  const isCheque = input.paymentMethod === PaymentMethod.CHEQUE;
  const collection = await CollectionModel.create({
    receiptNumber: input.receiptNumber,
    customer: customer._id,
    createdBy: actor._id,
    visit: visit?._id ?? null,
    amount,
    paymentMethod: input.paymentMethod,
    chequeNumber: isCheque ? (input.chequeNumber ?? null) : null,
    chequeDueDate: isCheque ? (input.chequeDueDate ?? null) : null,
    notes: input.notes || null,
    // A rep keeps the money until handing it to the treasury; a manager receives it directly.
    depositStatus: isManager(actor) ? DepositStatus.DEPOSITED : DepositStatus.PENDING,
    depositedAt: isManager(actor) ? new Date() : null,
  });

  await syncCustomerSummary(customer._id);
  return collection.populate(withRefs);
}

export function listCollections(
  { customerId, visitId }: ListCollectionsFilters,
  actor: UserDocument,
) {
  return CollectionModel.find({
    ...visibility(actor),
    ...(customerId && { customer: customerId }),
    ...(visitId && { visit: visitId }),
  })
    .sort({ createdAt: -1 })
    .populate(withRefs);
}

export async function getCollectionById(id: string, actor: UserDocument) {
  const collection = await CollectionModel.findOne({ _id: id, ...visibility(actor) }).populate(
    withRefs,
  );
  if (!collection) throw new AppError(404, 'Collection not found');
  return collection;
}

export async function cancelCollection(id: string, reason: string, actor: UserDocument) {
  const collection = await getCollectionById(id, actor);
  if (collection.status === CollectionStatus.CANCELLED)
    throw new AppError(400, 'Collection is already cancelled');

  collection.set({
    status: CollectionStatus.CANCELLED,
    cancelReason: reason,
    cancelledBy: actor._id,
    cancelledAt: new Date(),
  });
  await collection.save();
  await syncCustomerSummary(collection.customer._id);
  return collection.populate(withRefs);
}

export async function addAttachment(
  id: string,
  kind: AttachmentKind,
  file: Express.Multer.File,
  actor: UserDocument,
) {
  const collection = await getCollectionById(id, actor);
  collection.attachments.push({
    kind,
    fileName: file.filename,
    originalName: file.originalname,
    mimeType: file.mimetype,
    size: file.size,
    uploadedBy: actor._id,
  });
  await collection.save();
  return collection.populate(withRefs);
}

export async function getAttachment(id: string, attachmentId: string, actor: UserDocument) {
  const collection = await CollectionModel.findOne({ _id: id, ...visibility(actor) });
  const attachment = collection?.attachments.id(attachmentId);
  if (!attachment) throw new AppError(404, 'Attachment not found');
  return attachment;
}
