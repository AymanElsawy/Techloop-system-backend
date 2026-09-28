import type { Types } from 'mongoose';
import { SupplierModel } from './supplier.model.js';
import type {
  CreateSupplierInput,
  ListSuppliersFilters,
  UpdateSupplierInput,
} from './supplier.validation.js';
import { MovementModel } from '../inventory/inventory.model.js';
import { MovementType } from '../inventory/inventory.types.js';
import { AppError } from '../../utils/api-response.js';

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const round2 = (n: number) => Math.round(n * 100) / 100;

type Purchases = { _id: Types.ObjectId; receipts: number; total: number; lastAt: Date };

/** Receipts per supplier: count, total purchase value, last date. */
async function purchasesBySupplier(supplierIds: Types.ObjectId[]) {
  const rows = await MovementModel.aggregate<Purchases>([
    { $match: { type: MovementType.RECEIVE, supplier: { $in: supplierIds } } },
    { $unwind: '$items' },
    {
      $group: {
        _id: { movement: '$_id', supplier: '$supplier', at: '$createdAt' },
        value: { $sum: { $multiply: ['$items.quantity', { $ifNull: ['$items.unitCost', 0] }] } },
      },
    },
    {
      $group: {
        _id: '$_id.supplier',
        receipts: { $sum: 1 },
        total: { $sum: '$value' },
        lastAt: { $max: '$_id.at' },
      },
    },
  ]);
  return new Map(rows.map((r) => [String(r._id), r]));
}

export async function listSuppliers({ search, active }: ListSuppliersFilters) {
  const pattern = search ? new RegExp(escapeRegex(search), 'i') : null;
  const suppliers = await SupplierModel.find({
    ...(active !== undefined && { isActive: active }),
    ...(pattern && { $or: [{ name: pattern }, { phone: pattern }, { company: pattern }] }),
  }).sort({ name: 1 });
  const purchases = await purchasesBySupplier(suppliers.map((s) => s._id));
  return suppliers.map((s) => {
    const p = purchases.get(s.id as string);
    return {
      ...s.toJSON(),
      receipts: p?.receipts ?? 0,
      totalPurchases: round2(p?.total ?? 0),
      lastPurchaseAt: p?.lastAt ?? null,
    };
  });
}

export function createSupplier(input: CreateSupplierInput) {
  return SupplierModel.create(input);
}

export async function findSupplier(id: string | Types.ObjectId) {
  const supplier = await SupplierModel.findById(id);
  if (!supplier) throw new AppError(404, 'Supplier not found');
  return supplier;
}

export async function findActiveSupplier(id: string) {
  const supplier = await findSupplier(id);
  if (!supplier.isActive) throw new AppError(400, 'Supplier is inactive');
  return supplier;
}

export async function getSupplier(id: string) {
  const supplier = await findSupplier(id);
  const p = (await purchasesBySupplier([supplier._id])).get(supplier.id as string);
  return {
    ...supplier.toJSON(),
    receipts: p?.receipts ?? 0,
    totalPurchases: round2(p?.total ?? 0),
    lastPurchaseAt: p?.lastAt ?? null,
  };
}

export async function updateSupplier(id: string, input: UpdateSupplierInput) {
  const supplier = await findSupplier(id);
  supplier.set(input);
  await supplier.save();
  return getSupplier(id);
}
