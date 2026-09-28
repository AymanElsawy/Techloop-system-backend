import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { ProductUnit } from './product.types.js';

const productSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, default: null },
    unit: { type: String, enum: [...Object.values(ProductUnit), null], default: null },
    // ponytail: plain Number (EGP), same as customers; move to integer piasters with invoices.
    price: { type: Number, required: true, min: 0 },
    // Stock lives per warehouse / rep custody (inventory module). The API adds the total as `quantity`.
    minQuantity: { type: Number, default: null }, // low-stock alert threshold on the total
    // Purchase costs, updated by warehouse receipts (managers only; hidden from reps).
    avgCost: { type: Number, default: null }, // weighted moving average over total stock
    lastCost: { type: Number, default: null },
    lastSupplier: { type: Schema.Types.ObjectId, ref: 'Supplier', default: null },
    lastPurchaseAt: { type: Date, default: null },
    // Main supplier, picked on the product form (managers only). Receipts may still use others.
    supplier: { type: Schema.Types.ObjectId, ref: 'Supplier', default: null },
    manufacturer: { type: String, default: null },
    expiryDate: { type: Date, default: null },
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

// Unique code, ignoring products without one.
productSchema.index(
  { code: 1 },
  { unique: true, partialFilterExpression: { code: { $type: 'string' } } },
);
productSchema.index({ name: 1 });

export type Product = InferSchemaType<typeof productSchema>;
export type ProductDocument = HydratedDocument<Product>;

export const ProductModel = model('Product', productSchema);
