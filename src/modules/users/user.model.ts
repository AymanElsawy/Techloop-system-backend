import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { UserRole } from './user.types.js';
import { GOVERNORATES } from '../customers/customer.types.js';

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    // Login name, e.g. "ayman". Unique; the manager picks another one if it's taken.
    username: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, select: false },
    // New users start with the default password and must set their own on first login.
    mustChangePassword: { type: Boolean, default: false },
    role: { type: String, enum: Object.values(UserRole), required: true },
    isActive: { type: Boolean, default: true },
    // Sales rep's region. A rep only sees customers in these governorates (none = no customers).
    // Ignored for OWNER/ADMIN, who see everything.
    governorates: { type: [{ type: String, enum: GOVERNORATES }], default: [] },
    // Sales rep's warehouse: the rep's custody is issued from it and invoices draw on it.
    warehouse: { type: Schema.Types.ObjectId, ref: 'Warehouse', default: null },
    // Sales rep's monthly and yearly targets (EGP, null = none; either, both or neither)
    // and commission rates (% of net sales / collected).
    salesTarget: { type: Number, default: null, min: 0 },
    collectionTarget: { type: Number, default: null, min: 0 },
    yearlySalesTarget: { type: Number, default: null, min: 0 },
    yearlyCollectionTarget: { type: Number, default: null, min: 0 },
    salesCommissionRate: { type: Number, default: 0, min: 0, max: 100 },
    collectionCommissionRate: { type: Number, default: 0, min: 0, max: 100 },
    lastLoginAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.__v;
        delete ret.password;
        return ret;
      },
    },
  },
);

export type User = InferSchemaType<typeof userSchema> & { role: UserRole };
export type UserDocument = HydratedDocument<User>;

export const UserModel = model<User>('User', userSchema);
