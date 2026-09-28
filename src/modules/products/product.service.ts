import type { HydratedDocument, QueryFilter } from 'mongoose';
import { ProductModel, type Product } from './product.model.js';
import type {
  CreateProductInput,
  ListProductsFilters,
  UpdateProductInput,
} from './product.validation.js';
import type { UserDocument } from '../users/user.model.js';
import { UserRole } from '../users/user.types.js';
import { AppError } from '../../utils/api-response.js';
import { totalsByProduct } from '../inventory/inventory.service.js';
import { findActiveSupplier } from '../suppliers/supplier.service.js';

const isManager = (actor: UserDocument) =>
  actor.role === UserRole.OWNER || actor.role === UserRole.ADMIN;

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `supplierId` -> `supplier` (must be an active supplier; null clears it). */
async function withSupplier<T extends { supplierId?: string | null }>({ supplierId, ...rest }: T) {
  if (supplierId === undefined) return rest;
  return { ...rest, supplier: supplierId && (await findActiveSupplier(supplierId))._id };
}

export async function createProduct(input: CreateProductInput, actor: UserDocument) {
  return (await withQuantity([await ProductModel.create(await withSupplier(input))], actor))[0];
}

const COST_FIELDS = ['avgCost', 'lastCost', 'lastSupplier', 'lastPurchaseAt', 'supplier'] as const;

/**
 * Adds `quantity` (total stock across every warehouse and rep custody). Managers also get the
 * purchase costs with the main / last supplier's name; reps never see them.
 */
async function withQuantity(products: HydratedDocument<Product>[], actor: UserDocument) {
  const manager = isManager(actor);
  if (manager)
    await ProductModel.populate(products, [
      { path: 'lastSupplier', select: 'name' },
      { path: 'supplier', select: 'name' },
    ]);
  const totals = await totalsByProduct(products.map((p) => p._id));
  return products.map((p) => {
    const json: Record<string, unknown> = {
      ...p.toJSON(),
      quantity: totals.get(p.id as string) ?? 0,
    };
    if (!manager) for (const f of COST_FIELDS) delete json[f];
    return json as Product & { id: string; quantity: number };
  });
}

/** Sales reps only ever see active products. */
export async function listProducts(
  { search, unit, active, lowStock }: ListProductsFilters,
  actor: UserDocument,
) {
  const filters: QueryFilter<Product>[] = [];
  if (!isManager(actor)) filters.push({ isActive: true });
  else if (active !== undefined) filters.push({ isActive: active });
  if (unit) filters.push({ unit });
  if (lowStock) filters.push({ minQuantity: { $ne: null } });
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    filters.push({ $or: [{ name: pattern }, { code: pattern }, { manufacturer: pattern }] });
  }
  const products = await ProductModel.find(filters.length ? { $and: filters } : {}).sort({
    name: 1,
  });
  const list = await withQuantity(products, actor);
  return lowStock ? list.filter((p) => p.quantity <= (p.minQuantity as number)) : list;
}

async function findProduct(id: string, actor: UserDocument) {
  const product = await ProductModel.findOne({
    _id: id,
    ...(!isManager(actor) && { isActive: true }),
  });
  if (!product) throw new AppError(404, 'Product not found');
  return product;
}

export async function getProductById(id: string, actor: UserDocument) {
  return (await withQuantity([await findProduct(id, actor)], actor))[0];
}

export async function updateProduct(id: string, input: UpdateProductInput, actor: UserDocument) {
  const product = await findProduct(id, actor);
  product.set(await withSupplier(input));
  return (await withQuantity([await product.save()], actor))[0];
}
