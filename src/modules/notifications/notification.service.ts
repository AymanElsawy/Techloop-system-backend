import { Schema, Types, model } from 'mongoose';
import { DocumentType } from '../documents/documents.routes.js';
import { UserModel, type UserDocument } from '../users/user.model.js';
import { UserRole } from '../users/user.types.js';

export const SUPPLIER_PAYMENT = 'SUPPLIER_PAYMENT';
export const VISIT = 'VISIT';
// Stock alerts (managers only, no actor): docId is the product.
export const LOW_STOCK = 'LOW_STOCK';
export const EXPIRY_SOON = 'EXPIRY_SOON';
export const REP_EXPENSE = 'REP_EXPENSE'; // a rep spent from their cash box
// To the rep only: management took their cash box. No details, not opened on tap.
export const CASH_TAKEN = 'CASH_TAKEN';
// To a warehouse rep: someone else added stock to / returned goods into their warehouse. No details.
export const STOCK_ADDED = 'STOCK_ADDED';
export const STOCK_RETURNED = 'STOCK_RETURNED';
const EXTRA_TYPES = [
  SUPPLIER_PAYMENT,
  VISIT,
  LOW_STOCK,
  EXPIRY_SOON,
  REP_EXPENSE,
  CASH_TAKEN,
  STOCK_ADDED,
  STOCK_RETURNED,
] as const;
type NotificationType = DocumentType | (typeof EXTRA_TYPES)[number];

const refSchema = new Schema(
  { id: { type: String, required: true }, name: { type: String, required: true } },
  { _id: false },
);

// Data only: web and mobile build the (Arabic) text from it.
const NotificationModel = model(
  'Notification',
  new Schema(
    {
      user: { type: Types.ObjectId, ref: 'User', required: true }, // recipient
      type: {
        type: String,
        enum: [...Object.values(DocumentType), ...EXTRA_TYPES],
        required: true,
      },
      cancelled: { type: Boolean, default: false },
      docId: { type: String, required: true }, // opened on tap; the supplier for SUPPLIER_PAYMENT
      number: { type: String, default: null },
      actor: { type: refSchema, default: null }, // null for stock alerts
      party: { type: refSchema, default: null }, // customer, rep, supplier, or product
      amount: { type: Number, default: null },
      quantity: { type: Number, default: null }, // stock alerts: total left
      expiryDate: { type: Date, default: null }, // EXPIRY_SOON
      readAt: { type: Date, default: null },
    },
    {
      timestamps: true,
      toJSON: {
        transform: (_doc, ret: Record<string, unknown>) => {
          ret.id = String(ret._id);
          delete ret._id;
          delete ret.__v;
          delete ret.user;
          return ret;
        },
      },
    },
  ).index({ user: 1, createdAt: -1 }),
);

/** A populated ref ({ _id/id, name }) or a plain id, snapshotted as { id, name }. */
const ref = (doc: unknown) => {
  const d = doc as { id?: string; name?: string } | null | undefined;
  return d?.id && d.name ? { id: d.id, name: d.name } : null;
};

type Event = {
  type: NotificationType;
  cancelled?: boolean;
  docId: unknown;
  number: unknown;
  party?: unknown; // populated doc with a name
  amount?: number | null;
  quantity?: number | null;
  expiryDate?: Date | null;
};

/**
 * Tells every active owner/admin (and `rep`, if given) about a change, except whoever made it.
 * `actor` null = a system alert, sent to all of them.
 * Never throws: a failed notification must not fail the operation that already happened.
 */
export async function notify(
  event: Event,
  actor: UserDocument | null,
  rep?: Types.ObjectId | null,
  toManagers = true,
) {
  try {
    const managers = toManagers
      ? await UserModel.find({
          role: { $in: [UserRole.OWNER, UserRole.ADMIN] },
          isActive: true,
        }).select('_id')
      : [];
    const users = new Set([...managers.map((m) => String(m._id)), ...(rep ? [String(rep)] : [])]);
    if (actor) users.delete(String(actor._id));
    if (!users.size) return;
    const data = {
      type: event.type,
      cancelled: event.cancelled ?? false,
      docId: String(event.docId),
      number: event.number == null ? null : String(event.number),
      actor: actor && { id: actor.id as string, name: actor.name },
      party: ref(event.party),
      amount: event.amount ?? null,
      quantity: event.quantity ?? null,
      expiryDate: event.expiryDate ?? null,
    };
    await NotificationModel.insertMany([...users].map((user) => ({ ...data, user })));
  } catch (err) {
    console.error('notify failed', err);
  }
}

/** Tells the warehouse reps of `warehouse` (except the actor) that its stock changed. Never throws. */
export async function notifyWarehouse(
  type: typeof STOCK_ADDED | typeof STOCK_RETURNED,
  warehouse: Types.ObjectId,
  actor: UserDocument,
) {
  try {
    const reps = await UserModel.find({
      role: UserRole.WAREHOUSE_REP,
      warehouse,
      isActive: true,
      _id: { $ne: actor._id },
    }).select('_id');
    if (reps.length)
      await NotificationModel.insertMany(
        reps.map((r) => ({ user: r._id, type, docId: String(warehouse), number: null })),
      );
  } catch (err) {
    console.error('notify failed', err);
  }
}

// ponytail: fixed cap and no cleanup; add paging / a TTL index when the collection grows.
export const listNotifications = (actor: UserDocument) =>
  NotificationModel.find({ user: actor._id }).sort({ createdAt: -1 }).limit(100);

export const unreadCount = (actor: UserDocument) =>
  NotificationModel.countDocuments({ user: actor._id, readAt: null });

export const markAllRead = (actor: UserDocument) =>
  NotificationModel.updateMany({ user: actor._id, readAt: null }, { readAt: new Date() });
