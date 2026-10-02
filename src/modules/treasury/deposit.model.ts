import { Schema, Types, model, type InferSchemaType } from 'mongoose';

/** A handover: a manager receives money from a rep's cash box into the company treasury. */
const depositSchema = new Schema(
  {
    number: { type: Number, required: true, unique: true }, // استلام رقم
    rep: { type: Types.ObjectId, ref: 'User', required: true, index: true },
    receivedBy: { type: Types.ObjectId, ref: 'User', required: true },
    invoices: [{ type: Types.ObjectId, ref: 'Invoice' }],
    collections: [{ type: Types.ObjectId, ref: 'Collection' }],
    expenses: [{ type: Types.ObjectId, ref: 'TreasuryEntry' }], // the rep's expenses accepted here
    total: { type: Number, required: true }, // payments − expenses: what was actually handed over
    notes: { type: String, default: null },
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

export type Deposit = InferSchemaType<typeof depositSchema>;
export const DepositModel = model('Deposit', depositSchema);
