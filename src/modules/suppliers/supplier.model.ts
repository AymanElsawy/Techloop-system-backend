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

export type Supplier = InferSchemaType<typeof supplierSchema>;
export type SupplierDocument = HydratedDocument<Supplier>;
export const SupplierModel = model('Supplier', supplierSchema);
