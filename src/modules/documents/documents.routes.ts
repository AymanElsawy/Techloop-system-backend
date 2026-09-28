import { Router } from 'express';
import { z } from 'zod';
import { InvoiceModel } from '../invoices/invoice.model.js';
import { CollectionModel } from '../collections/collection.model.js';
import { MovementModel } from '../inventory/inventory.model.js';
import { MovementType } from '../inventory/inventory.types.js';
import { DepositModel } from '../treasury/deposit.model.js';
import { ReturnModel } from '../returns/return.model.js';
import { UserRole } from '../users/user.types.js';
import type { UserDocument } from '../users/user.model.js';
import { authenticate } from '../../middleware/auth.middleware.js';
import { ok } from '../../utils/api-response.js';

/** Every printable document in one list: sales, collections, purchases, custody moves, handovers. */
export enum DocumentType {
  SALE = 'SALE',
  SALE_RETURN = 'SALE_RETURN',
  COLLECTION = 'COLLECTION',
  PURCHASE = 'PURCHASE',
  ISSUE = 'ISSUE',
  RETURN = 'RETURN',
  DEPOSIT = 'DEPOSIT',
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const listSchema = z.object({
  type: z.enum(DocumentType).optional(),
  from: day.optional(),
  to: day.optional(),
  search: z.string().trim().max(100).optional(),
});

type Ref = { id: string; name: string } | null;
type DocumentRow = {
  type: DocumentType;
  id: string;
  number: string;
  date: Date;
  party: Ref; // customer, supplier, or rep
  by: Ref;
  amount: number | null; // money; null for custody moves
  quantity: number | null; // custody moves
  status: 'ACTIVE' | 'CANCELLED';
};

const ref = (doc: unknown): Ref => {
  const d = doc as { id?: string; name?: string } | null;
  return d?.id ? { id: d.id, name: d.name ?? '' } : null;
};
const round2 = (n: number) => Math.round(n * 100) / 100;
const LIMIT = 500; // ponytail: per source, add paging when a range holds more

const MOVEMENT_TYPES = {
  [MovementType.RECEIVE]: DocumentType.PURCHASE,
  [MovementType.ISSUE]: DocumentType.ISSUE,
  [MovementType.RETURN]: DocumentType.RETURN,
} as const;

async function listDocuments(filters: z.infer<typeof listSchema>, actor: UserDocument) {
  const manager = actor.role === UserRole.OWNER || actor.role === UserRole.ADMIN;
  const want = (t: DocumentType) => !filters.type || filters.type === t;
  const createdAt = {
    ...(filters.from && { $gte: new Date(`${filters.from}T00:00:00`) }),
    ...(filters.to && { $lte: new Date(`${filters.to}T23:59:59.999`) }),
  };
  const range = Object.keys(createdAt).length ? { createdAt } : {};
  const mine = manager ? {} : { createdBy: actor._id };
  const person = { path: 'customer createdBy', select: 'name' };

  const movementTypes = (Object.keys(MOVEMENT_TYPES) as (keyof typeof MOVEMENT_TYPES)[]).filter(
    (t) => want(MOVEMENT_TYPES[t]) && (manager || t !== MovementType.RECEIVE),
  );

  const [invoices, collections, movements, deposits, returns] = await Promise.all([
    want(DocumentType.SALE)
      ? InvoiceModel.find({ ...mine, ...range })
          .sort({ createdAt: -1 })
          .limit(LIMIT)
          .populate(person)
      : [],
    want(DocumentType.COLLECTION)
      ? CollectionModel.find({ ...mine, ...range })
          .sort({ createdAt: -1 })
          .limit(LIMIT)
          .populate(person)
      : [],
    movementTypes.length
      ? MovementModel.find({
          type: { $in: movementTypes },
          ...(!manager && { rep: actor._id }),
          ...range,
        })
          .sort({ createdAt: -1 })
          .limit(LIMIT)
          .populate({ path: 'supplier rep createdBy', select: 'name' })
      : [],
    want(DocumentType.DEPOSIT)
      ? DepositModel.find({ ...(!manager && { rep: actor._id }), ...range })
          .sort({ createdAt: -1 })
          .limit(LIMIT)
          .populate({ path: 'rep receivedBy', select: 'name' })
      : [],
    want(DocumentType.SALE_RETURN)
      ? ReturnModel.find({ ...mine, ...range })
          .sort({ createdAt: -1 })
          .limit(LIMIT)
          .populate(person)
      : [],
  ]);

  const rows: DocumentRow[] = [
    ...invoices.map((i) => ({
      type: DocumentType.SALE,
      id: i.id as string,
      number: i.invoiceNumber,
      date: i.createdAt,
      party: ref(i.customer),
      by: ref(i.createdBy),
      amount: i.total,
      quantity: null,
      status: i.status,
    })),
    ...collections.map((c) => ({
      type: DocumentType.COLLECTION,
      id: c.id as string,
      number: c.receiptNumber,
      date: c.createdAt,
      party: ref(c.customer),
      by: ref(c.createdBy),
      amount: c.amount,
      quantity: null,
      status: c.status,
    })),
    ...movements.map((m) => {
      const type = MOVEMENT_TYPES[m.type as keyof typeof MOVEMENT_TYPES];
      return {
        type,
        id: m.id as string,
        number: String(m.number ?? '—'),
        date: m.createdAt,
        party: ref(type === DocumentType.PURCHASE ? m.supplier : m.rep),
        by: ref(m.createdBy),
        amount:
          type === DocumentType.PURCHASE
            ? round2(m.items.reduce((s, i) => s + i.quantity * (i.unitCost ?? 0), 0))
            : null,
        quantity: m.items.reduce((s, i) => s + i.quantity, 0),
        status: 'ACTIVE' as const,
      };
    }),
    ...returns.map((r) => ({
      type: DocumentType.SALE_RETURN,
      id: r.id as string,
      number: String(r.number),
      date: r.createdAt,
      party: ref(r.customer),
      by: ref(r.createdBy),
      amount: r.total,
      quantity: null,
      status: r.status,
    })),
    ...deposits.map((d) => ({
      type: DocumentType.DEPOSIT,
      id: d.id as string,
      number: String(d.number),
      date: d.createdAt,
      party: ref(d.rep),
      by: ref(d.receivedBy),
      amount: d.total,
      quantity: null,
      status: 'ACTIVE' as const,
    })),
  ];

  const q = filters.search?.toLowerCase();
  return rows
    .filter(
      (r) => !q || r.number.toLowerCase().includes(q) || r.party?.name.toLowerCase().includes(q),
    )
    .sort((a, b) => b.date.getTime() - a.date.getTime());
}

export const documentRoutes = Router();

documentRoutes.get('/', authenticate, async (req, res) => {
  ok(res, await listDocuments(listSchema.parse(req.query), req.user!));
});
