import { Schema, Types, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { AttachmentKind, InvoiceStatus, PaymentMethod } from './invoice.types.js';
import { depositFields } from '../treasury/treasury.types.js';

// Snapshot of the product at sale time, so later price/name changes don't rewrite history.
const itemSchema = new Schema(
  {
    product: { type: Types.ObjectId, ref: 'Product', required: true },
    name: { type: String, required: true },
    unit: { type: String, default: null },
    unitPrice: { type: Number, required: true },
    quantity: { type: Number, required: true },
    total: { type: Number, required: true },
    fromCustody: { type: Number, default: 0 }, // taken from the rep's custody; the rest from the warehouse
  },
  { _id: false },
);

export const attachmentSchema = new Schema({
  kind: { type: String, enum: Object.values(AttachmentKind), required: true },
  fileName: { type: String, required: true }, // stored name on disk (random)
  originalName: { type: String, required: true },
  mimeType: { type: String, required: true },
  size: { type: Number, required: true },
  uploadedBy: { type: Types.ObjectId, ref: 'User', required: true },
  uploadedAt: { type: Date, default: Date.now },
});

/** toJSON helper shared with collections: expose `id`, hide the internal disk file name. */
export function serializeAttachments(ret: Record<string, unknown>) {
  for (const a of (ret.attachments as Record<string, unknown>[]) ?? []) {
    a.id = String(a._id);
    delete a._id;
    delete a.fileName;
  }
}

const invoiceSchema = new Schema(
  {
    invoiceNumber: { type: String, required: true, trim: true, unique: true },
    customer: { type: Types.ObjectId, ref: 'Customer', required: true, index: true },
    createdBy: { type: Types.ObjectId, ref: 'User', required: true, index: true },
    visit: { type: Types.ObjectId, ref: 'Visit', default: null, index: true },
    // Stock source: the warehouse, plus the rep whose custody was used first (null for managers).
    warehouse: { type: Types.ObjectId, ref: 'Warehouse', required: true },
    rep: { type: Types.ObjectId, ref: 'User', default: null },
    items: { type: [itemSchema], required: true },

    // ponytail: plain Number (EGP), rounded to 2 decimals; move to integer piasters with the accounting work.
    total: { type: Number, required: true },
    paidAmount: { type: Number, required: true, default: 0 },
    remaining: { type: Number, required: true }, // left unpaid on this invoice
    previousDebtPaid: { type: Number, default: 0 }, // paid above the total, settles older debt
    paymentMethod: { type: String, enum: [...Object.values(PaymentMethod), null], default: null },
    chequeNumber: { type: String, default: null },
    chequeDueDate: { type: Date, default: null },
    notes: { type: String, default: null },
    ...depositFields, // up-front payment; null when nothing was paid

    status: { type: String, enum: Object.values(InvoiceStatus), default: InvoiceStatus.ACTIVE },
    cancelReason: { type: String, default: null },
    cancelledBy: { type: Types.ObjectId, ref: 'User', default: null },
    cancelledAt: { type: Date, default: null },

    attachments: { type: [attachmentSchema], default: [] },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.__v;
        serializeAttachments(ret);
        return ret;
      },
    },
  },
);

export type Invoice = InferSchemaType<typeof invoiceSchema>;
export type InvoiceDocument = HydratedDocument<Invoice>;

export const InvoiceModel = model('Invoice', invoiceSchema);
