import { Schema, Types, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { CustomerStatus, CustomerType, GOVERNORATES } from './customer.types.js';

const moneyEvent = new Schema(
  { date: { type: Date, required: true }, amount: { type: Number, required: true } },
  { _id: false },
);

const customerSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: Object.values(CustomerType), default: CustomerType.OTHER },
    phone: { type: String, default: null },
    contactPerson: { type: String, default: null },

    governorate: { type: String, enum: GOVERNORATES, required: true },
    city: { type: String, default: null },
    address: { type: String, default: null },
    location: {
      type: new Schema({ latitude: Number, longitude: Number }, { _id: false }),
      default: null,
    },

    notes: { type: String, default: null },
    // حد الائتمان: max debt a rep may sell up to; null = no limit. Managers only.
    creditLimit: { type: Number, default: null },
    // مدة السداد: new invoices are due this many days after the sale; null = no terms. Managers only.
    paymentTermDays: { type: Number, default: null },
    // Default discount on this customer's invoices, and the most a rep may give; null = none. Managers only.
    discountPercent: { type: Number, default: null },

    status: { type: String, enum: Object.values(CustomerStatus), required: true },
    rejectionReason: { type: String, default: null },
    createdBy: { type: Types.ObjectId, ref: 'User', required: true },
    reviewedBy: { type: Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },

    // Financial summary. Never set through the customers API; the invoices and
    // collections modules will update these.
    // ponytail: plain Number (EGP) while everything is 0; move to integer piasters when invoices land.
    debit: { type: Number, default: 0 }, // مدين: what the customer owes
    credit: { type: Number, default: 0 }, // دائن: what the company owes the customer
    lastInvoice: { type: moneyEvent, default: null },
    lastCollection: { type: moneyEvent, default: null },
    // Collected by a rep but not yet handed to the treasury; not deducted from debit yet.
    pendingPayments: { type: Number, default: 0 },
    // Fixed public balance link (رابط المديونية); created on first use, see modules/public/statement.ts.
    shareToken: { type: String, default: null },
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

// Unique phone, ignoring customers without one (null is not a string).
customerSchema.index(
  { phone: 1 },
  { unique: true, partialFilterExpression: { phone: { $type: 'string' } } },
);
customerSchema.index({ governorate: 1, name: 1 });
customerSchema.index(
  { shareToken: 1 },
  { unique: true, partialFilterExpression: { shareToken: { $type: 'string' } } },
);

export type Customer = InferSchemaType<typeof customerSchema>;
export type CustomerDocument = HydratedDocument<Customer>;

export const CustomerModel = model('Customer', customerSchema);
