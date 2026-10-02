import { Schema, Types, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { PaymentMethod } from '../invoices/invoice.types.js';
import { SupplierPaymentStatus } from './supplier-payment.types.js';

/** A payment made to a supplier, outside of a receipt; reduces the supplier's debt. */
const supplierPaymentSchema = new Schema(
  {
    number: { type: Number, required: true, unique: true },
    supplier: { type: Types.ObjectId, ref: 'Supplier', required: true, index: true },
    createdBy: { type: Types.ObjectId, ref: 'User', required: true },

    // ponytail: plain Number (EGP), rounded to 2 decimals, same as invoices/collections.
    amount: { type: Number, required: true },
    paymentMethod: { type: String, enum: Object.values(PaymentMethod), required: true },
    chequeNumber: { type: String, default: null },
    chequeDueDate: { type: Date, default: null },
    notes: { type: String, default: null },

    status: {
      type: String,
      enum: Object.values(SupplierPaymentStatus),
      default: SupplierPaymentStatus.ACTIVE,
    },
    cancelReason: { type: String, default: null },
    cancelledBy: { type: Types.ObjectId, ref: 'User', default: null },
    cancelledAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  },
);

export type SupplierPayment = InferSchemaType<typeof supplierPaymentSchema>;
export type SupplierPaymentDocument = HydratedDocument<SupplierPayment>;
export const SupplierPaymentModel = model('SupplierPayment', supplierPaymentSchema);
