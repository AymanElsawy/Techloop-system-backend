import { Schema, Types, model, type InferSchemaType } from 'mongoose';
import { DepositStatus, TreasuryEntryStatus, TreasuryEntryType } from './treasury.types.js';
import { PaymentMethod } from '../invoices/invoice.types.js';

/** An expense, a withdrawal, or a bank deposit taken out of the treasury by a manager. */
const treasuryEntrySchema = new Schema(
  {
    number: { type: Number, required: true, unique: true },
    type: { type: String, enum: Object.values(TreasuryEntryType), required: true },
    amount: { type: Number, required: true },
    paymentMethod: { type: String, enum: Object.values(PaymentMethod), required: true }, // taken from
    category: { type: String, default: null }, // EXPENSE only, e.g. "بنزين"
    notes: { type: String, default: null },
    createdBy: { type: Types.ObjectId, ref: 'User', required: true },
    // Rep expense (مصروف مندوب): paid from the rep's cash box. PENDING until a manager accepts it
    // in a handover; only then it leaves the treasury. Manager entries have neither (null).
    rep: { type: Types.ObjectId, ref: 'User', default: null, index: true },
    depositStatus: { type: String, enum: [...Object.values(DepositStatus), null], default: null },
    deposit: { type: Types.ObjectId, ref: 'Deposit', default: null },

    status: {
      type: String,
      enum: Object.values(TreasuryEntryStatus),
      default: TreasuryEntryStatus.ACTIVE,
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

export type TreasuryEntry = InferSchemaType<typeof treasuryEntrySchema>;
export const TreasuryEntryModel = model('TreasuryEntry', treasuryEntrySchema);
