import { z } from 'zod';
import { MovementType } from './inventory.types.js';

export const objectId = z.string().regex(/^[0-9a-f]{24}$/i, 'Invalid id');

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v === '' ? null : v));

export const createWarehouseSchema = z.object({
  name: z.string().trim().min(2).max(80),
  notes: optionalText(500),
});

export const updateWarehouseSchema = createWarehouseSchema
  .extend({ isActive: z.boolean() })
  .partial();

const itemsSchema = z
  .array(z.object({ productId: objectId, quantity: z.number().int().positive() }))
  .min(1)
  .refine(
    (items) => new Set(items.map((i) => i.productId)).size === items.length,
    'Duplicate product',
  );

// A receipt comes from a supplier and records the purchase price, which feeds the product's costs.
export const receiveSchema = z.object({
  supplierId: objectId,
  items: z
    .array(
      z.object({
        productId: objectId,
        quantity: z.number().int().positive(),
        unitCost: z.number().nonnegative(),
      }),
    )
    .min(1)
    .refine(
      (items) => new Set(items.map((i) => i.productId)).size === items.length,
      'Duplicate product',
    ),
  // What's actually paid to the supplier now; the rest becomes debt. Defaults to fully paid.
  paidAmount: z.number().nonnegative().optional(),
  notes: optionalText(500),
});

export const transferSchema = z.object({
  repId: objectId,
  items: itemsSchema,
  notes: optionalText(500),
});

// جرد: the quantity actually counted in the warehouse; the server records the difference.
export const adjustSchema = z.object({
  items: z
    .array(z.object({ productId: objectId, counted: z.number().int().nonnegative() }))
    .min(1)
    .refine(
      (items) => new Set(items.map((i) => i.productId)).size === items.length,
      'Duplicate product',
    ),
  reason: z.string().trim().min(3).max(500),
});

export const warehouseTransferSchema = z.object({
  toWarehouseId: objectId,
  items: itemsSchema,
  notes: optionalText(500),
});

export const listMovementsSchema = z.object({
  warehouseId: objectId.optional(),
  repId: objectId.optional(),
  type: z.enum(MovementType).optional(),
  supplierId: objectId.optional(),
  productId: objectId.optional(),
});

export type StockItemInput = z.infer<typeof itemsSchema>;
export type CreateWarehouseInput = z.infer<typeof createWarehouseSchema>;
export type UpdateWarehouseInput = z.infer<typeof updateWarehouseSchema>;
export type ReceiveInput = z.infer<typeof receiveSchema>;
export type TransferInput = z.infer<typeof transferSchema>;
export type AdjustInput = z.infer<typeof adjustSchema>;
export type WarehouseTransferInput = z.infer<typeof warehouseTransferSchema>;
export type ListMovementsFilters = z.infer<typeof listMovementsSchema>;
