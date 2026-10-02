import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/** Someone the company buys goods from. Receipts into a warehouse point at a supplier. */
const supplierSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, unique: true },
    phone: { type: String, default: null },
    company: { type: String, default: null },
    address: { type: String, default: null },
    notes: { type: String, default: null },
    isActive: { type: Boolean, default: true },
    // Never set directly through the suppliers API; synced from receive movements and payments.
    debt: { type: Number, default: 0 },
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

supplierSchema.index(
  { shareToken: 1 },
  { unique: true, partialFilterExpression: { shareToken: { $type: 'string' } } },
);

export type Supplier = InferSchemaType<typeof supplierSchema>;
export type SupplierDocument = HydratedDocument<Supplier>;
export const SupplierModel = model('Supplier', supplierSchema);
