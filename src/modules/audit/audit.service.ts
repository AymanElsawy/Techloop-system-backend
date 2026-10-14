import { Schema, Types, model } from 'mongoose';
import { z } from 'zod';
import type { UserDocument } from '../users/user.model.js';

export enum AuditAction {
  CANCEL = 'CANCEL',
  UPDATE = 'UPDATE',
  DELETE = 'DELETE',
  APPROVE = 'APPROVE',
  REJECT = 'REJECT',
}

export enum AuditEntity {
  INVOICE = 'INVOICE',
  COLLECTION = 'COLLECTION',
  RETURN = 'RETURN',
  TREASURY_ENTRY = 'TREASURY_ENTRY',
  SUPPLIER_PAYMENT = 'SUPPLIER_PAYMENT', // docId is the supplier, like its notification
  CUSTOMER = 'CUSTOMER',
  SUPPLIER = 'SUPPLIER',
  PRODUCT = 'PRODUCT',
  USER = 'USER',
}

/**
 * سجل العمليات: who cancelled or edited what, and when. Append only, the owner reads it.
 * Everything is a snapshot taken at that moment (names, Arabic field labels and values),
 * so later renames or deletes don't rewrite history.
 */
const AuditLogModel = model(
  'AuditLog',
  new Schema(
    {
      actor: {
        type: new Schema({ id: String, name: String }, { _id: false }),
        required: true,
      },
      action: { type: String, enum: Object.values(AuditAction), required: true },
      entity: { type: String, enum: Object.values(AuditEntity), required: true },
      docId: { type: String, required: true },
      title: { type: String, default: null }, // document number, or the customer / product / user name
      party: { type: String, default: null }, // customer or supplier name
      amount: { type: Number, default: null },
      reason: { type: String, default: null },
      changes: {
        type: [new Schema({ field: String, from: String, to: String }, { _id: false })],
        default: [],
      },
    },
    {
      timestamps: { createdAt: true, updatedAt: false },
      toJSON: {
        transform: (_doc, ret: Record<string, unknown>) => {
          ret.id = String(ret._id);
          delete ret._id;
          delete ret.__v;
          return ret;
        },
      },
    },
  ).index({ createdAt: -1 }),
);

// Only these fields count as an edit; anything else (summaries, timestamps) is ignored.
const FIELD_LABELS: Record<string, string> = {
  name: 'الاسم',
  username: 'اسم الدخول',
  password: 'كلمة المرور',
  role: 'الدور',
  type: 'النوع',
  phone: 'الهاتف',
  contactPerson: 'الشخص المسؤول',
  governorate: 'المحافظة',
  governorates: 'المحافظات',
  city: 'المدينة',
  address: 'العنوان',
  location: 'الموقع',
  notes: 'ملاحظات',
  creditLimit: 'حد الائتمان',
  paymentTermDays: 'مدة السداد (يوم)',
  discountPercent: 'نسبة الخصم %',
  price: 'سعر البيع',
  lastCost: 'سعر الشراء',
  supplier: 'المورد',
  unit: 'الوحدة',
  code: 'الكود',
  minQuantity: 'الحد الأدنى',
  manufacturer: 'الشركة المصنعة',
  expiryDate: 'الصلاحية',
  warehouse: 'المخزن',
  salesTarget: 'تارجت المبيعات الشهري',
  collectionTarget: 'تارجت التحصيل الشهري',
  yearlySalesTarget: 'تارجت المبيعات السنوي',
  yearlyCollectionTarget: 'تارجت التحصيل السنوي',
  salesCommissionRate: 'عمولة المبيعات %',
  collectionCommissionRate: 'عمولة التحصيل %',
  isActive: 'الحالة',
  chequeStatus: 'حالة الشيك',
  // Nightly balance check (actor = the system).
  balance: 'الرصيد',
  pendingPayments: 'مع المندوب',
  debt: 'المديونية',
};

// Kept in sync with the web/mobile labels.
const VALUE_LABELS: Record<string, string> = {
  ADMIN: 'مدير النظام',
  SALES_REP: 'مندوب',
  WAREHOUSE_REP: 'مندوب مخزن',
  CLINIC: 'عيادة بيطرية',
  FARM: 'مزرعة',
  PHARMACY: 'صيدلية بيطرية',
  TRADER: 'تاجر',
  OTHER: 'أخرى',
  LITER: 'لتر',
  PACK: 'عبوة',
  CARTON: 'كرتونة',
  CLEARED: 'اتصرف',
  BOUNCED: 'ارتد',
};

// Id fields shown by name (looked up by model name, so no import cycles).
const REF_MODELS: Record<string, string> = { supplier: 'Supplier', warehouse: 'Warehouse' };

/** Comparable form: ids and dates as strings, empty as null. */
function plain(v: unknown): unknown {
  if (v == null || v === '') return null;
  if (v instanceof Types.ObjectId) return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (Array.isArray(v)) return v.length ? v.map(plain) : null;
  if (typeof v === 'object' && 'latitude' in v) {
    const { latitude, longitude } = v as { latitude: number; longitude: number };
    return `${latitude}, ${longitude}`;
  }
  return v;
}

async function display(field: string, v: unknown): Promise<string | null> {
  if (v === null) return null;
  if (field === 'isActive') return v ? 'نشط' : 'موقوف';
  if (REF_MODELS[field]) {
    const doc = await model(REF_MODELS[field]).findById(v).select('name');
    return (doc?.get('name') as string | undefined) ?? null;
  }
  if (Array.isArray(v)) return v.join('، ');
  return VALUE_LABELS[String(v)] ?? String(v);
}

/** Labeled fields that differ between two plain snapshots (`doc.toObject()` before and after). */
export async function diff(before: Record<string, unknown>, after: Record<string, unknown>) {
  const changes = [];
  for (const field of Object.keys(FIELD_LABELS)) {
    if (!(field in after)) continue;
    const [from, to] = [plain(before[field]), plain(after[field])];
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    changes.push(
      field === 'password' // never store hashes: just "changed"
        ? { field: FIELD_LABELS[field]!, from: null, to: null }
        : { field: FIELD_LABELS[field]!, from: await display(field, from), to: await display(field, to) },
    );
  }
  return changes;
}

type Entry = {
  docId: unknown;
  title?: unknown;
  party?: unknown; // a populated doc with a name
  amount?: number | null;
  reason?: string | null;
  /** UPDATE: snapshots around the change; nothing is logged when no labeled field changed. */
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
};

/** Never throws: a failed log line must not fail the operation that already happened. */
export async function audit(
  actor: UserDocument | null, // null = the system (nightly balance check)
  action: AuditAction,
  entity: AuditEntity,
  e: Entry,
) {
  try {
    const changes = e.before && e.after ? await diff(e.before, e.after) : [];
    if (action === AuditAction.UPDATE && !changes.length) return;
    await AuditLogModel.create({
      actor: actor ? { id: actor.id as string, name: actor.name } : { id: 'system', name: 'السيستم' },
      action,
      entity,
      docId: String(e.docId),
      title: e.title == null ? null : String(e.title),
      party: (e.party as { name?: string } | null | undefined)?.name ?? null,
      amount: e.amount ?? null,
      reason: e.reason ?? null,
      changes,
    });
  } catch (err) {
    console.error('audit failed', err);
  }
}

export const listAuditSchema = z.object({
  entity: z.enum(AuditEntity).optional(),
  actorId: z.string().regex(/^[0-9a-f]{24}$/i, 'Invalid id').optional(),
});

// ponytail: kept forever, no TTL; the log is small (edits and cancels only). The cap only applies without `?page=`.
export const listAudit = ({ entity, actorId }: z.infer<typeof listAuditSchema>) =>
  AuditLogModel.find({
    ...(entity && { entity }),
    ...(actorId && { 'actor.id': actorId }),
  })
    .sort({ createdAt: -1 })
    .limit(100);
