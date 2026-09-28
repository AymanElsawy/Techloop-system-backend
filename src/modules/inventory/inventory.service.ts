import { Types } from 'mongoose';
import { MovementModel, StockModel, WarehouseModel } from './inventory.model.js';
import { MovementType } from './inventory.types.js';
import type {
  CreateWarehouseInput,
  ListMovementsFilters,
  ReceiveInput,
  StockItemInput,
  TransferInput,
  UpdateWarehouseInput,
} from './inventory.validation.js';
import { ProductModel } from '../products/product.model.js';
import { UserModel, type UserDocument } from '../users/user.model.js';
import { UserRole } from '../users/user.types.js';
import { AppError } from '../../utils/api-response.js';
import { findActiveSupplier } from '../suppliers/supplier.service.js';

type Id = Types.ObjectId;
/** A stock location: a warehouse's main stock or a rep's custody (exactly one is set). */
type Location = { warehouse: Id | null; rep: Id | null };
type LineItem = { product: Id; name: string; quantity: number };

const mainOf = (warehouse: Id): Location => ({ warehouse, rep: null });
const custodyOf = (rep: Id): Location => ({ warehouse: null, rep });

const isManager = (actor: UserDocument) =>
  actor.role === UserRole.OWNER || actor.role === UserRole.ADMIN;

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

export async function listWarehouses() {
  const [warehouses, totals, reps] = await Promise.all([
    WarehouseModel.find().sort({ name: 1 }),
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
export async function getWarehouseDetails(id: string) {
  const warehouse = await findWarehouse(id);
  const reps = await UserModel.find({ role: UserRole.SALES_REP, warehouse: warehouse._id })
    .select('name email isActive')
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
    notes?: string | null;
  },
  items: (LineItem & { fromCustody?: number; unitCost?: number })[],
  actor: UserDocument,
) {
  return nextMovementNumber(type)
    .then((number) => MovementModel.create({ type, number, ...data, items, createdBy: actor._id }))
    .then((movement) => movement.populate(movementRefs));
}

const NUMBERED = new Set([MovementType.RECEIVE, MovementType.ISSUE, MovementType.RETURN]);

// ponytail: max+1 per type, a concurrent insert can get the same number; add a counter doc if it matters.
async function nextMovementNumber(type: MovementType) {
  if (!NUMBERED.has(type)) return null; // sales and returns print under their own number
  const last = await MovementModel.findOne({ type }).sort({ number: -1 }).select('number');
  return (last?.number ?? 0) + 1;
}

const movementRefs = [
  { path: 'warehouse', select: 'name' },
  { path: 'rep createdBy', select: 'name' },
  { path: 'invoice', select: 'invoiceNumber' },
  { path: 'supplier', select: 'name phone company address' },
];

/** One movement, e.g. for printing. Reps only see their own custody movements, never purchases. */
export async function getMovement(id: string, actor: UserDocument) {
  const movement = await MovementModel.findOne({
    _id: id,
    ...(!isManager(actor) && { rep: actor._id }),
  }).populate(movementRefs);
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

  return logMovement(
    MovementType.RECEIVE,
    { warehouse: warehouse._id, supplier: supplier._id, notes: input.notes },
    items,
    actor,
  );
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
  const rep = await findRepOf(warehouse._id, input.repId);
  const items = await toLineItems(input.items);
  await moveItems(mainOf(warehouse._id), custodyOf(rep._id), items);
  return logMovement(
    MovementType.ISSUE,
    { warehouse: warehouse._id, rep: rep._id, notes: input.notes },
    items,
    actor,
  );
}

export async function returnFromRep(id: string, input: TransferInput, actor: UserDocument) {
  const warehouse = await findWarehouse(id);
  const rep = await findRepOf(warehouse._id, input.repId);
  const items = await toLineItems(input.items);
  await moveItems(custodyOf(rep._id), mainOf(warehouse._id), items);
  return logMovement(
    MovementType.RETURN,
    { warehouse: warehouse._id, rep: rep._id, notes: input.notes },
    items,
    actor,
  );
}

/** Reps only see movements of their own custody. */
export function listMovements(
  { warehouseId, repId, type, supplierId }: ListMovementsFilters,
  actor: UserDocument,
) {
  const rep = isManager(actor) ? repId : actor.id;
  return MovementModel.find({
    ...(warehouseId && { warehouse: warehouseId }),
    ...(rep && { rep }),
    ...(type && { type }),
    ...(supplierId && { supplier: supplierId }),
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
