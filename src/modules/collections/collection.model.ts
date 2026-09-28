import { Schema, Types, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { CollectionStatus } from './collection.types.js';
import { PaymentMethod } from '../invoices/invoice.types.js';
import { attachmentSchema, serializeAttachments } from '../invoices/invoice.model.js';
import { depositFields } from '../treasury/treasury.types.js';

/** A payment received from a customer without a sale; reduces the customer's total debt once deposited. */
const collectionSchema = new Schema(
  {
    receiptNumber: { type: String, required: true, trim: true, unique: true },
    customer: { type: Types.ObjectId, ref: 'Customer', required: true, index: true },
    createdBy: { type: Types.ObjectId, ref: 'User', required: true, index: true },
    visit: { type: Types.ObjectId, ref: 'Visit', default: null, index: true },

    // ponytail: plain Number (EGP), rounded to 2 decimals, same as invoices.
    amount: { type: Number, required: true },
    paymentMethod: { type: String, enum: Object.values(PaymentMethod), required: true },
    chequeNumber: { type: String, default: null },
    chequeDueDate: { type: Date, default: null },
    notes: { type: String, default: null },
    ...depositFields,

    status: {
      type: String,
      enum: Object.values(CollectionStatus),
      default: CollectionStatus.ACTIVE,
    },
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

export type Collection = InferSchemaType<typeof collectionSchema>;
export type CollectionDocument = HydratedDocument<Collection>;

export const CollectionModel = model('Collection', collectionSchema);
