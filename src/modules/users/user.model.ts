import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { UserRole } from './user.types.js';
import { GOVERNORATES } from '../customers/customer.types.js';

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, select: false },
    role: { type: String, enum: Object.values(UserRole), required: true },
    isActive: { type: Boolean, default: true },
    // Sales rep's region. A rep only sees customers in these governorates (none = no customers).
    // Ignored for OWNER/ADMIN, who see everything.
    governorates: { type: [{ type: String, enum: GOVERNORATES }], default: [] },
    // Sales rep's warehouse: the rep's custody is issued from it and invoices draw on it.
    warehouse: { type: Schema.Types.ObjectId, ref: 'Warehouse', default: null },
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
