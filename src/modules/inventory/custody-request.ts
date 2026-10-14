import { Router, type Request } from 'express';
import { Schema, Types, model } from 'mongoose';
import { z } from 'zod';
import { assertWarehouseAccess, issueToRep, toLineItems } from './inventory.service.js';
import { itemsSchema } from './inventory.validation.js';
import { authorize } from '../../middleware/role.middleware.js';
import { AppError, ok } from '../../utils/api-response.js';
import { sendList } from '../../utils/paginate.js';
import { UserModel, type UserDocument } from '../users/user.model.js';
import { UserRole } from '../users/user.types.js';
import {
  CUSTODY_REJECTED,
  CUSTODY_REQUEST,
  notify,
} from '../notifications/notification.service.js';

export enum CustodyRequestStatus {
  PENDING = 'PENDING',
  ISSUED = 'ISSUED', // approved: the goods went to the rep's custody (`movement`)
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED', // by the rep, while pending
}

/** طلب عهدة: a sales rep asks their warehouse for goods; a warehouse rep or a manager issues or rejects it. */
const CustodyRequestModel = model(
  'CustodyRequest',
  new Schema(
    {
      number: { type: Number, required: true, unique: true },
      rep: { type: Types.ObjectId, ref: 'User', required: true, index: true },
      warehouse: { type: Types.ObjectId, ref: 'Warehouse', required: true, index: true },
      items: {
        type: [
          new Schema(
            {
              product: { type: Types.ObjectId, ref: 'Product', required: true },
              name: { type: String, required: true },
              quantity: { type: Number, required: true },
            },
            { _id: false },
          ),
        ],
        required: true,
      },
      notes: { type: String, default: null },
      status: {
        type: String,
        enum: Object.values(CustodyRequestStatus),
        default: CustodyRequestStatus.PENDING,
        index: true,
      },
      movement: { type: Types.ObjectId, ref: 'StockMovement', default: null }, // the ISSUE, once issued
      reason: { type: String, default: null }, // why it was rejected
      handledBy: { type: Types.ObjectId, ref: 'User', default: null },
      handledAt: { type: Date, default: null },
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
  ),
);

const refs = [
  { path: 'rep handledBy', select: 'name' },
  { path: 'warehouse', select: 'name' },
  { path: 'movement', select: 'number' },
];

const isManager = (u: UserDocument) => u.role === UserRole.OWNER || u.role === UserRole.ADMIN;

/** Reps see their own requests, a warehouse rep their warehouse's, managers all. */
const scopeOf = (actor: UserDocument) =>
  actor.role === UserRole.SALES_REP
    ? { rep: actor._id }
    : actor.role === UserRole.WAREHOUSE_REP
      ? { warehouse: actor.warehouse }
      : {};

const createSchema = z.object({
  items: itemsSchema,
  notes: z.string().trim().max(500).nullish(),
});
const issueSchema = z.object({
  // The quantities actually issued; missing = as requested. Lines can be dropped or lowered.
  items: itemsSchema.optional(),
  notes: z.string().trim().max(500).nullish(),
});
const rejectSchema = z.object({ reason: z.string().trim().min(3).max(500) });
const listSchema = z.object({ status: z.enum(CustodyRequestStatus).optional() });

async function create(input: z.infer<typeof createSchema>, actor: UserDocument) {
  if (!actor.warehouse) throw new AppError(400, 'You are not attached to a warehouse');
  const items = await toLineItems(input.items);
  const last = await CustodyRequestModel.findOne().sort({ number: -1 }).select('number');
  const request = await CustodyRequestModel.create({
    number: (last?.number ?? 0) + 1,
    rep: actor._id,
    warehouse: actor.warehouse,
    items,
    notes: input.notes || null,
  });
  // Managers, and the warehouse reps of that warehouse (who issue it).
  const event = {
    type: CUSTODY_REQUEST as typeof CUSTODY_REQUEST,
    docId: request.id,
    number: request.number,
    party: actor,
  };
  await notify(event, actor);
  const whReps = await UserModel.find({
    role: UserRole.WAREHOUSE_REP,
    warehouse: actor.warehouse,
    isActive: true,
  }).select('_id');
  for (const w of whReps) await notify(event, actor, w._id, false);
  return request.populate(refs);
}

/**
 * Takes a pending request (only one handler wins) for the actor's warehouse.
 * `status` is set right away; `undo` puts it back to pending if the next step fails.
 */
async function claim(id: string, status: CustodyRequestStatus, actor: UserDocument, extra = {}) {
  const request = Types.ObjectId.isValid(id)
    ? await CustodyRequestModel.findOne({ _id: id, ...scopeOf(actor) })
    : null;
  if (!request) throw new AppError(404, 'Request not found');
  assertWarehouseAccess(actor, request.warehouse);
  const claimed = await CustodyRequestModel.findOneAndUpdate(
    { _id: request._id, status: CustodyRequestStatus.PENDING },
    { status, handledBy: actor._id, handledAt: new Date(), ...extra },
    { returnDocument: 'after' },
  );
  if (!claimed) throw new AppError(400, 'Request is no longer pending');
  const undo = () =>
    CustodyRequestModel.updateOne(
      { _id: request._id },
      { status: CustodyRequestStatus.PENDING, handledBy: null, handledAt: null, reason: null },
    );
  return { request: claimed, undo };
}

async function issue(id: string, input: z.infer<typeof issueSchema>, actor: UserDocument) {
  const { request, undo } = await claim(id, CustodyRequestStatus.ISSUED, actor);
  try {
    const movement = await issueToRep(
      String(request.warehouse),
      {
        repId: String(request.rep),
        items:
          input.items ??
          request.items.map((i) => ({ productId: String(i.product), quantity: i.quantity })),
        notes: input.notes || `طلب عهدة رقم ${request.number}`,
      },
      actor,
    );
    request.movement = movement._id;
    await request.save();
  } catch (err) {
    await undo(); // e.g. not enough stock: still pending, the handler can lower the quantities
    throw err;
  }
  return request.populate(refs);
}

async function reject(id: string, reason: string, actor: UserDocument) {
  const { request } = await claim(id, CustodyRequestStatus.REJECTED, actor, { reason });
  await notify(
    { type: CUSTODY_REJECTED, docId: request.id, number: request.number },
    actor,
    request.rep,
    false,
  );
  return request.populate(refs);
}

async function cancel(id: string, actor: UserDocument) {
  const request = await CustodyRequestModel.findOneAndUpdate(
    { _id: id, rep: actor._id, status: CustodyRequestStatus.PENDING },
    { status: CustodyRequestStatus.CANCELLED, handledBy: actor._id, handledAt: new Date() },
    { returnDocument: 'after' },
  );
  if (!request) throw new AppError(400, 'Request is no longer pending');
  return request.populate(refs);
}

// Mounted at /inventory/requests (behind `authenticate`).
export const custodyRequestRoutes = Router();

const handlers = authorize(UserRole.OWNER, UserRole.ADMIN, UserRole.WAREHOUSE_REP);
const repsOnly = authorize(UserRole.SALES_REP);

custodyRequestRoutes.get('/', async (req, res) => {
  const { status } = listSchema.parse(req.query);
  await sendList(
    res,
    req.query,
    CustodyRequestModel.find({ ...scopeOf(req.user!), ...(status && { status }) })
      .sort({ createdAt: -1 })
      .limit(isManager(req.user!) ? 200 : 100) // ponytail: cap without ?page=
      .populate(refs),
  );
});
custodyRequestRoutes.post('/', repsOnly, async (req, res) => {
  ok(res, await create(createSchema.parse(req.body), req.user!), 201);
});
custodyRequestRoutes.post('/:id/issue', handlers, async (req: Request<{ id: string }>, res) => {
  ok(res, await issue(req.params.id, issueSchema.parse(req.body ?? {}), req.user!));
});
custodyRequestRoutes.post('/:id/reject', handlers, async (req: Request<{ id: string }>, res) => {
  ok(res, await reject(req.params.id, rejectSchema.parse(req.body).reason, req.user!));
});
custodyRequestRoutes.post('/:id/cancel', repsOnly, async (req: Request<{ id: string }>, res) => {
  ok(res, await cancel(req.params.id, req.user!));
});
