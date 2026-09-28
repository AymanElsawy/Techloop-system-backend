import { Schema, Types, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { VisitPurpose, VisitStatus } from './visit.types.js';

const visitSchema = new Schema(
  {
    customer: { type: Types.ObjectId, ref: 'Customer', required: true, index: true },
    salesRep: { type: Types.ObjectId, ref: 'User', required: true, index: true },
    createdBy: { type: Types.ObjectId, ref: 'User', required: true },
    purpose: { type: String, enum: Object.values(VisitPurpose), required: true },
    scheduledAt: { type: Date, required: true, index: true },
    status: { type: String, enum: Object.values(VisitStatus), default: VisitStatus.PLANNED },

    startedAt: { type: Date, default: null },
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },

    completedAt: { type: Date, default: null },
    notes: { type: String, default: null },
    productsDiscussed: { type: [String], default: [] },
    customerFeedback: { type: String, default: null },
    nextVisitAt: { type: Date, default: null },

    cancelReason: { type: String, default: null },
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

export type Visit = InferSchemaType<typeof visitSchema>;
export type VisitDocument = HydratedDocument<Visit>;

export const VisitModel = model('Visit', visitSchema);
