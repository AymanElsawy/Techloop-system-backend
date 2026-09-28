import { Schema, Types, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

export enum ReturnStatus {
  ACTIVE = 'ACTIVE',
  CANCELLED = 'CANCELLED',
}

const itemSchema = new Schema(
  {
    product: { type: Types.ObjectId, ref: 'Product', required: true },
    name: { type: String, required: true },
    unit: { type: String, default: null },
    unitPrice: { type: Number, required: true }, // the price on the original invoice
    quantity: { type: Number, required: true },
    total: { type: Number, required: true },
  },
  { _id: false },
);

/** فاتورة مرتجع: goods a customer gives back from a sales invoice; the total reduces their debt. */
const returnSchema = new Schema(
  {
    number: { type: Number, required: true, unique: true },
    invoice: { type: Types.ObjectId, ref: 'Invoice', required: true, index: true },
    customer: { type: Types.ObjectId, ref: 'Customer', required: true, index: true },
    createdBy: { type: Types.ObjectId, ref: 'User', required: true, index: true },
    // Where the goods went: the rep's custody (rep set), or the warehouse's main stock.
    warehouse: { type: Types.ObjectId, ref: 'Warehouse', required: true },
    rep: { type: Types.ObjectId, ref: 'User', default: null },
    items: { type: [itemSchema], required: true },
    total: { type: Number, required: true }, // ponytail: plain Number (EGP), same as invoices
    notes: { type: String, default: null },

    status: { type: String, enum: Object.values(ReturnStatus), default: ReturnStatus.ACTIVE },
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

export type SalesReturn = InferSchemaType<typeof returnSchema>;
export type SalesReturnDocument = HydratedDocument<SalesReturn>;
export const ReturnModel = model('SalesReturn', returnSchema);
