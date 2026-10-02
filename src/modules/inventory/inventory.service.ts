import { Types } from 'mongoose';
import { MovementModel, StockModel, WarehouseModel } from './inventory.model.js';
import { MovementType } from './inventory.types.js';
import type {
  AdjustInput,
  CreateWarehouseInput,
  ListMovementsFilters,
  ReceiveInput,
  StockItemInput,
  TransferInput,
  UpdateWarehouseInput,
  WarehouseTransferInput,
} from './inventory.validation.js';
import { ProductModel } from '../products/product.model.js';
import { UserModel, type UserDocument } from '../users/user.model.js';
import { UserRole } from '../users/user.types.js';
import { AppError } from '../../utils/api-response.js';
import { findActiveSupplier } from '../suppliers/supplier.service.js';
import { syncSupplierDebt } from '../suppliers/supplier-balance.js';
import {
  LOW_STOCK,
  STOCK_ADDED,
  STOCK_RETURNED,
  notify,
  notifyWarehouse,
} from '../notifications/notification.service.js';
import { DocumentType } from '../documents/documents.routes.js';

type Id = Types.ObjectId;
/** A stock location: a warehouse's main stock or a rep's custody (exactly one is set). */
type Location = { warehouse: Id | null; rep: Id | null };
type LineItem = { product: Id; name: string; quantity: number };

const mainOf = (warehouse: Id): Location => ({ warehouse, rep: null });
const custodyOf = (rep: Id): Location => ({ warehouse: null, rep });

const isManager = (actor: UserDocument) =>
  actor.role === UserRole.OWNER || actor.role === UserRole.ADMIN;

/** A warehouse rep only operates their assigned warehouse; managers operate any. */
function assertWarehouseAccess(actor: UserDocument, warehouseId: Id) {
  if (actor.role === UserRole.WAREHOUSE_REP && String(actor.warehouse) !== String(warehouseId)) {
    throw new AppError(403, 'Forbidden');
  }
}

const productRef = { path: 'product', select: 'name code unit price minQuantity isActive' };

// ---------- stock primitives ----------

async function take(loc: Location, product: Id, quantity: number) {
  const res = await StockModel.updateOne(
    { ...loc, product, quantity: { $gte: quantity } },
    { $inc: { quantity: -quantity } },
  );
  return res.modifiedCount === 1;
}

async function put(loc: Location, product: Id, quantity: number) {
  await StockModel.updateOne({ ...loc, product }, { $inc: { quantity } }, { upsert: true });
}

/**
 * Moves items between locations (`null` = outside the system, e.g. a supplier).
 * The conditional decrement never lets stock go below zero.
 * ponytail: no transaction (MongoDB is standalone); already-taken items are put back
 * if a later one fails. Use a replica-set session if concurrent edits become a problem.
 */
async function moveItems(from: Location | null, to: Location | null, items: LineItem[]) {
  const taken: LineItem[] = [];
  if (from) {
    for (const item of items) {
      if (!(await take(from, item.product, item.quantity))) {
        for (const t of taken) await put(from, t.product, t.quantity);
        throw new AppError(400, `Not enough stock for ${item.name}`);
      }
      taken.push(item);
    }
  }
  if (to) for (const item of items) await put(to, item.product, item.quantity);
}

async function toLineItems(items: StockItemInput): Promise<LineItem[]> {
  const ids = items.map((i) => i.productId);
  const products = await ProductModel.find({ _id: { $in: ids } });
  if (products.length !== ids.length) throw new AppError(400, 'One or more products not found');
  const byId = new Map(products.map((p) => [p.id as string, p]));
  return items.map(({ productId, quantity }) => {
    const p = byId.get(productId)!;
    return { product: p._id, name: p.name, quantity };
  });
}

/** Total quantity per product across every location (main stock + custody). */
export async function totalsByProduct(productIds?: Id[]) {
  const rows = await StockModel.aggregate<{ _id: Id; total: number }>([
    ...(productIds ? [{ $match: { product: { $in: productIds } } }] : []),
    { $group: { _id: '$product', total: { $sum: '$quantity' } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.total]));
}

// ---------- warehouses ----------

export async function listWarehouses(actor: UserDocument) {
  if (actor.role === UserRole.WAREHOUSE_REP && !actor.warehouse) return [];
  const scope = actor.role === UserRole.WAREHOUSE_REP ? { _id: actor.warehouse } : {};
  const [warehouses, totals, reps] = await Promise.all([
    WarehouseModel.find(scope).sort({ name: 1 }),
    StockModel.aggregate<{ _id: Id; total: number }>([
      { $match: { warehouse: { $ne: null } } },
      { $group: { _id: '$warehouse', total: { $sum: '$quantity' } } },
    ]),
    UserModel.aggregate<{ _id: Id; count: number }>([
      { $match: { role: UserRole.SALES_REP, warehouse: { $ne: null } } },
      { $group: { _id: '$warehouse', count: { $sum: 1 } } },
    ]),
  ]);
  const totalOf = new Map(totals.map((t) => [String(t._id), t.total]));
  const repsOf = new Map(reps.map((r) => [String(r._id), r.count]));
  return warehouses.map((w) => ({
    ...w.toJSON(),
    totalQuantity: totalOf.get(w.id) ?? 0,
    repsCount: repsOf.get(w.id) ?? 0,
  }));
}

export function createWarehouse(input: CreateWarehouseInput) {
  return WarehouseModel.create(input);
}

async function findWarehouse(id: string | Id) {
  const warehouse = await WarehouseModel.findById(id);
  if (!warehouse) throw new AppError(404, 'Warehouse not found');
  return warehouse;
}

async function findActiveWarehouse(id: string | Id) {
  const warehouse = await findWarehouse(id);
  if (!warehouse.isActive) throw new AppError(400, 'Warehouse is inactive');
  return warehouse;
}

export async function updateWarehouse(id: string, input: UpdateWarehouseInput) {
  const warehouse = await findWarehouse(id);
  warehouse.set(input);
  return warehouse.save();
}

/** Main stock plus every rep attached to the warehouse with their custody. */
export async function getWarehouseDetails(id: string, actor: UserDocument) {
  const warehouse = await findWarehouse(id);
  assertWarehouseAccess(actor, warehouse._id);
  const reps = await UserModel.find({ role: UserRole.SALES_REP, warehouse: warehouse._id })
    .select('name username isActive')
    .sort({ name: 1 });
  const [stock, custody] = await Promise.all([
    StockModel.find({ ...mainOf(warehouse._id), quantity: { $gt: 0 } }).populate(productRef),
    StockModel.find({ rep: { $in: reps.map((r) => r._id) }, quantity: { $gt: 0 } }).populate(
      productRef,
    ),
  ]);
  return {
    warehouse,
    stock,
    reps: reps.map((rep) => ({
      rep,
      custody: custody.filter((c) => String(c.rep) === rep.id),
    })),
  };
}

// ---------- movements (managers) ----------

function logMovement(
  type: MovementType,
  data: {
    warehouse: Id;
    rep?: Id | null;
    invoice?: Id | null;
    supplier?: Id | null;
    toWarehouse?: Id | null;
    notes?: string | null;
    totalCost?: number | null;
    paidAmount?: number | null;
  },
  items: (LineItem & { fromCustody?: number; unitCost?: number })[],
  actor: UserDocument,
) {
  return nextMovementNumber(type)
    .then((number) => MovementModel.create({ type, number, ...data, items, createdBy: actor._id }))
    .then(async (movement) => {
      // Only these take goods out of the system; issue / return just move them.
      if (type === MovementType.SALE || type === MovementType.SALE_RETURN_CANCEL)
        await alertLowStock(items).catch((err: unknown) =>
          console.error('Low-stock alert failed', err),
        );
      return movement.populate(movementRefs);
    });
}

/**
 * Tells managers when a product's total stock drops to its reorder level (minQuantity).
 * Only on crossing it, not on every later sale while it stays below.
 */
async function alertLowStock(items: LineItem[]) {
  const ids = items.map((i) => i.product);
  const [totals, products] = await Promise.all([
    totalsByProduct(ids),
    ProductModel.find({ _id: { $in: ids }, minQuantity: { $ne: null } }).select('name minQuantity'),
  ]);
  for (const p of products) {
    const min = p.minQuantity!;
    const after = totals.get(p.id as string) ?? 0;
    const taken = items.filter((i) => i.product.equals(p._id)).reduce((s, i) => s + i.quantity, 0);
    if (after <= min && after + taken > min)
      await notify({ type: LOW_STOCK, docId: p.id, number: null, party: p, quantity: after }, null);
  }
}

const NUMBERED = new Set([
  MovementType.RECEIVE,
  MovementType.ISSUE,
  MovementType.RETURN,
  MovementType.ADJUST,
  MovementType.TRANSFER,
]);

// ponytail: max+1 per type, a concurrent insert can get the same number; add a counter doc if it matters.
async function nextMovementNumber(type: MovementType) {
  if (!NUMBERED.has(type)) return null; // sales and returns print under their own number
  const last = await MovementModel.findOne({ type }).sort({ number: -1 }).select('number');
  return (last?.number ?? 0) + 1;
}

const movementRefs = [
  { path: 'warehouse toWarehouse', select: 'name' },
  { path: 'rep createdBy', select: 'name' },
  { path: 'invoice', select: 'invoiceNumber' },
  { path: 'supplier', select: 'name phone company address' },
];

/**
 * Movements a user may see: managers all; a warehouse rep the issues/returns of their warehouse
 * (what they operate, no purchases); a sales rep their own custody movements.
 */
function movementScope(actor: UserDocument) {
  if (isManager(actor)) return {};
  if (actor.role === UserRole.WAREHOUSE_REP) {
    return {
      warehouse: actor.warehouse ?? new Types.ObjectId(), // none assigned: matches nothing
      type: { $in: [MovementType.ISSUE, MovementType.RETURN] },
    };
  }
  return { rep: actor._id };
}

/** One movement, e.g. for printing. */
export async function getMovement(id: string, actor: UserDocument) {
  const movement = await MovementModel.findOne({ _id: id, ...movementScope(actor) }).populate(
    movementRefs,
  );
  if (!movement) throw new AppError(404, 'Movement not found');
  return movement;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Goods bought from a supplier enter a warehouse. Each product keeps one record: its average
 * purchase price is a weighted moving average over the total stock, and the last purchase
 * price / supplier are remembered.
 */
export async function receiveStock(id: string, input: ReceiveInput, actor: UserDocument) {
  const warehouse = await findActiveWarehouse(id);
  const supplier = await findActiveSupplier(input.supplierId);
  const lines = await toLineItems(input.items);
  const items = lines.map((l, i) => ({ ...l, unitCost: round2(input.items[i]!.unitCost) }));

  const totalCost = round2(items.reduce((sum, i) => sum + i.quantity * i.unitCost!, 0));
  const paidAmount = input.paidAmount != null ? round2(input.paidAmount) : totalCost;
  if (paidAmount > totalCost) throw new AppError(400, 'Paid amount exceeds the total cost');

  const before = await totalsByProduct(items.map((i) => i.product));
  await moveItems(null, mainOf(warehouse._id), items);

  // ponytail: read-then-write per product, not atomic with a concurrent receipt of the same product.
  const products = await ProductModel.find({ _id: { $in: items.map((i) => i.product) } });
  const now = new Date();
  for (const item of items) {
    const product = products.find((p) => p._id.equals(item.product))!;
    const oldQty = Math.max(before.get(String(item.product)) ?? 0, 0);
    const oldAvg = product.avgCost;
    product.avgCost =
      oldQty > 0 && oldAvg != null
        ? round2((oldQty * oldAvg + item.quantity * item.unitCost) / (oldQty + item.quantity))
        : item.unitCost;
    product.lastCost = item.unitCost;
    product.lastSupplier = supplier._id;
    product.lastPurchaseAt = now;
    await product.save();
  }

  const movement = await logMovement(
    MovementType.RECEIVE,
    { warehouse: warehouse._id, supplier: supplier._id, notes: input.notes, totalCost, paidAmount },
    items,
    actor,
  );
  await syncSupplierDebt(supplier._id);
  await notify(
    {
      type: DocumentType.PURCHASE,
      docId: movement.id,
      number: movement.number,
      party: movement.supplier,
      amount: totalCost,
    },
    actor,
  );
  await notifyWarehouse(STOCK_ADDED, warehouse._id, actor);
  return movement;
}

/** The rep must be attached to this warehouse. */
async function findRepOf(warehouseId: Id, repId: string) {
  const rep = await UserModel.findOne({ _id: repId, role: UserRole.SALES_REP });
  if (!rep) throw new AppError(404, 'Sales rep not found');
  if (String(rep.warehouse) !== String(warehouseId))
    throw new AppError(400, 'Sales rep is not attached to this warehouse');
  return rep;
}

export async function issueToRep(id: string, input: TransferInput, actor: UserDocument) {
  const warehouse = await findActiveWarehouse(id);
  assertWarehouseAccess(actor, warehouse._id);
  const rep = await findRepOf(warehouse._id, input.repId);
  const items = await toLineItems(input.items);
  await moveItems(mainOf(warehouse._id), custodyOf(rep._id), items);
  const movement = await logMovement(
    MovementType.ISSUE,
    { warehouse: warehouse._id, rep: rep._id, notes: input.notes },
    items,
    actor,
  );
  await notify(
    { type: DocumentType.ISSUE, docId: movement.id, number: movement.number, party: rep },
    actor,
    rep._id,
  );
  return movement;
}

export async function returnFromRep(id: string, input: TransferInput, actor: UserDocument) {
  const warehouse = await findWarehouse(id);
  assertWarehouseAccess(actor, warehouse._id);
  const rep = await findRepOf(warehouse._id, input.repId);
  const items = await toLineItems(input.items);
  await moveItems(custodyOf(rep._id), mainOf(warehouse._id), items);
  const movement = await logMovement(
    MovementType.RETURN,
    { warehouse: warehouse._id, rep: rep._id, notes: input.notes },
    items,
    actor,
  );
  await notify(
    { type: DocumentType.RETURN, docId: movement.id, number: movement.number, party: rep },
    actor,
    rep._id,
  );
  await notifyWarehouse(STOCK_RETURNED, warehouse._id, actor);
  return movement;
}

/**
 * تسوية جرد (managers): the counted quantity replaces the warehouse's main stock; the movement
 * records the signed difference per product with the reason. Average cost doesn't change.
 */
export async function adjustStock(id: string, input: AdjustInput, actor: UserDocument) {
  const warehouse = await findActiveWarehouse(id);
  const lines = await toLineItems(
    input.items.map((i) => ({ productId: i.productId, quantity: 1 })),
  );
  const current = await StockModel.find({
    ...mainOf(warehouse._id),
    product: { $in: lines.map((l) => l.product) },
  });
  const onHand = new Map(current.map((s) => [String(s.product), s.quantity]));
  const diffs = lines
    .map((l, i) => ({
      ...l,
      quantity: input.items[i]!.counted - (onHand.get(String(l.product)) ?? 0),
    }))
    .filter((l) => l.quantity !== 0);
  if (!diffs.length) throw new AppError(400, 'Counted stock matches the system');

  const shortage = diffs
    .filter((d) => d.quantity < 0)
    .map((d) => ({ ...d, quantity: -d.quantity }));
  await moveItems(mainOf(warehouse._id), null, shortage); // a sale in between makes this fail, not go negative
  await moveItems(
    null,
    mainOf(warehouse._id),
    diffs.filter((d) => d.quantity > 0),
  );
  const movement = await logMovement(
    MovementType.ADJUST,
    { warehouse: warehouse._id, notes: input.reason },
    diffs,
    actor,
  );
  if (shortage.length)
    await alertLowStock(shortage).catch((err: unknown) =>
      console.error('Low-stock alert failed', err),
    );
  return movement;
}

/** Main stock of one warehouse to another (managers). Shows in both warehouses' logs. */
export async function transferStock(
  id: string,
  input: WarehouseTransferInput,
  actor: UserDocument,
) {
  const from = await findActiveWarehouse(id);
  const to = await findActiveWarehouse(input.toWarehouseId);
  if (from._id.equals(to._id)) throw new AppError(400, 'Pick a different warehouse');
  const items = await toLineItems(input.items);
  await moveItems(mainOf(from._id), mainOf(to._id), items);
  const movement = await logMovement(
    MovementType.TRANSFER,
    { warehouse: from._id, toWarehouse: to._id, notes: input.notes },
    items,
    actor,
  );
  await notifyWarehouse(STOCK_ADDED, to._id, actor);
  return movement;
}

/** Filters apply inside the actor's scope (see movementScope). */
export function listMovements(
  { warehouseId, repId, type, supplierId, productId }: ListMovementsFilters,
  actor: UserDocument,
) {
  return MovementModel.find({
    $and: [
      movementScope(actor),
      {
        // A transfer shows in both warehouses' logs.
        ...(warehouseId && { $or: [{ warehouse: warehouseId }, { toWarehouse: warehouseId }] }),
        ...(repId && { rep: repId }),
        ...(type && { type }),
        ...(supplierId && { supplier: supplierId }),
        ...(productId && { 'items.product': productId }),
      },
    ],
  })
    .sort({ createdAt: -1 })
    .limit(300) // ponytail: fixed cap, add paging when the log grows
    .populate(movementRefs);
}

/** A rep's custody plus the main stock of the warehouse they sell from. */
export async function getMyStock(actor: UserDocument) {
  const warehouse = actor.warehouse ? await WarehouseModel.findById(actor.warehouse) : null;
  const [custody, warehouseStock] = await Promise.all([
    StockModel.find({ ...custodyOf(actor._id), quantity: { $gt: 0 } }).populate(productRef),
    warehouse
      ? StockModel.find({ ...mainOf(warehouse._id), quantity: { $gt: 0 } }).populate(productRef)
      : [],
  ]);
  return { warehouse, custody, warehouseStock };
}

// ---------- invoices ----------

/**
 * Takes sold items out of stock. A rep sells from their custody first; the rest comes from
 * the main stock of the rep's warehouse. A manager sells from the warehouse they pick.
 * Returns where each item came from, so a cancel can put it back.
 */
export async function takeForSale(
  items: LineItem[],
  warehouseId: string | null | undefined,
  actor: UserDocument,
) {
  const rep = isManager(actor) ? null : actor._id;
  const whId = rep ? actor.warehouse : warehouseId;
  if (!whId)
    throw new AppError(400, rep ? 'No warehouse is assigned to you' : 'Warehouse is required');
  const warehouse = await findActiveWarehouse(whId);

  const custody = rep
    ? await StockModel.find({ ...custodyOf(rep), product: { $in: items.map((i) => i.product) } })
    : [];
  const inCustody = new Map(custody.map((s) => [String(s.product), s.quantity]));
  const split = items.map((i) => {
    const fromCustody = Math.min(inCustody.get(String(i.product)) ?? 0, i.quantity);
    return { ...i, fromCustody };
  });

  const custodyPart = split
    .filter((i) => i.fromCustody > 0)
    .map((i) => ({ ...i, quantity: i.fromCustody }));
  const warehousePart = split
    .filter((i) => i.quantity > i.fromCustody)
    .map((i) => ({ ...i, quantity: i.quantity - i.fromCustody }));

  if (rep) await moveItems(custodyOf(rep), null, custodyPart);
  try {
    await moveItems(mainOf(warehouse._id), null, warehousePart);
  } catch (err) {
    if (rep) await moveItems(null, custodyOf(rep), custodyPart);
    throw err;
  }
  return { warehouse: warehouse._id, rep, items: split };
}

type SaleSource = {
  warehouse: Id;
  rep: Id | null;
  items: (LineItem & { fromCustody: number })[];
};

/** Puts sold items back exactly where takeForSale took them from. */
export async function returnSale(sale: SaleSource) {
  if (sale.rep) {
    const custodyPart = sale.items
      .filter((i) => i.fromCustody > 0)
      .map((i) => ({ ...i, quantity: i.fromCustody }));
    await moveItems(null, custodyOf(sale.rep), custodyPart);
  }
  const warehousePart = sale.items
    .filter((i) => i.quantity > i.fromCustody)
    .map((i) => ({ ...i, quantity: i.quantity - i.fromCustody }));
  await moveItems(null, mainOf(sale.warehouse), warehousePart);
}

export function logSale(
  type: MovementType.SALE | MovementType.SALE_CANCEL,
  sale: SaleSource & { invoice: Id },
  actor: UserDocument,
) {
  return logMovement(type, sale, sale.items, actor);
}

// ---------- sales returns ----------

/** Where returned goods go: the rep's custody, or a warehouse's main stock. */
type ReturnTarget = { warehouse: Id; rep: Id | null };
const targetOf = (t: ReturnTarget) => (t.rep ? custodyOf(t.rep) : mainOf(t.warehouse));

export async function receiveSaleReturn(
  items: LineItem[],
  target: ReturnTarget,
  invoice: Id,
  actor: UserDocument,
) {
  await moveItems(null, targetOf(target), items);
  return logMovement(MovementType.SALE_RETURN, { ...target, invoice }, items, actor);
}

/** Fails (400) if the returned goods were already sold or moved on. */
export async function cancelSaleReturn(
  items: LineItem[],
  target: ReturnTarget,
  invoice: Id,
  actor: UserDocument,
) {
  await moveItems(targetOf(target), null, items);
  return logMovement(MovementType.SALE_RETURN_CANCEL, { ...target, invoice }, items, actor);
}

/** A rep cannot move to another warehouse while holding custody. */
export async function assertCanChangeWarehouse(repId: Id) {
  if (await StockModel.exists({ ...custodyOf(repId), quantity: { $gt: 0 } }))
    throw new AppError(400, 'Return the rep custody before changing the warehouse');
}

export { findActiveWarehouse };
