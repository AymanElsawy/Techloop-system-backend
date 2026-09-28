import { z } from 'zod';
import { ProductUnit } from './product.types.js';

// Optional text: '' or null clears the field, undefined leaves it unchanged.
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v === '' ? null : v));

export const createProductSchema = z.object({
  name: z.string().trim().min(2).max(120),
  price: z.number().nonnegative(),
  supplierId: z.string().regex(/^[0-9a-f]{24}$/i, 'Invalid id').nullish(), // null clears it
  unit: z.enum(ProductUnit).nullish(),
  code: optionalText(40),
  minQuantity: z.number().int().nonnegative().nullish(),
  manufacturer: optionalText(120),
  expiryDate: z.iso.date().nullish(), // YYYY-MM-DD
  notes: optionalText(1000),
  isActive: z.boolean().optional(),
});

export const updateProductSchema = createProductSchema.partial();

export const listProductsSchema = z.object({
  search: z.string().trim().max(100).optional(),
  unit: z.enum(ProductUnit).optional(),
  active: z.stringbool().optional(),
  lowStock: z.stringbool().optional(),
});

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type ListProductsFilters = z.infer<typeof listProductsSchema>;
