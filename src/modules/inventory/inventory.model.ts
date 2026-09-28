import { Schema, Types, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { MovementType } from './inventory.types.js';

const toJSON = {
  transform: (_doc: unknown, ret: Record<string, unknown>) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
};

const warehouseSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, unique: true },
    notes: { type: String, default: null },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true, toJSON },
);

// One row per (location, product). A location is either a warehouse's main stock
// (warehouse set, rep null) or a sales rep's custody (rep set, warehouse null).
const stockSchema = new Schema(
  {
    warehouse: { type: Types.ObjectId, ref: 'Warehouse', default: null },
    rep: { type: Types.ObjectId, ref: 'User', default: null },
    product: { type: Types.ObjectId, ref: 'Product', required: true },
    quantity: { type: Number, required: true, default: 0, min: 0 },
  },
  { timestamps: true, toJSON },
);
stockSchema.index({ warehouse: 1, rep: 1, product: 1 }, { unique: true });

const movementItemSchema = new Schema(
  {
    product: { type: Types.ObjectId, ref: 'Product', required: true },
    name: { type: String, required: true }, // snapshot
    quantity: { type: Number, required: true },
    fromCustody: { type: Number, default: 0 }, // SALE / SALE_CANCEL only
    unitCost: { type: Number, default: null }, // RECEIVE only: purchase price per unit
  },
  { _id: false },
);

// Append-only log of every stock change.
const movementSchema = new Schema(
  {
    type: { type: String, enum: Object.values(MovementType), required: true },
    // Printable document number, per type (RECEIVE / ISSUE / RETURN). Sales use the invoice number.
    number: { type: Number, default: null },
    warehouse: { type: Types.ObjectId, ref: 'Warehouse', required: true, index: true },
    rep: { type: Types.ObjectId, ref: 'User', default: null, index: true },
    invoice: { type: Types.ObjectId, ref: 'Invoice', default: null },
    supplier: { type: Types.ObjectId, ref: 'Supplier', default: null, index: true }, // RECEIVE only
    items: { type: [movementItemSchema], required: true },
    notes: { type: String, default: null },
    createdBy: { type: Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true, toJSON },
);

export type Warehouse = InferSchemaType<typeof warehouseSchema>;
export type WarehouseDocument = HydratedDocument<Warehouse>;

export const WarehouseModel = model('Warehouse', warehouseSchema);
export const StockModel = model('Stock', stockSchema);
export const MovementModel = model('StockMovement', movementSchema);
