import { z } from 'zod';

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v === '' ? null : v));

export const createSupplierSchema = z.object({
  name: z.string().trim().min(2).max(120),
  phone: optionalText(30),
  company: optionalText(120),
  address: optionalText(300),
  notes: optionalText(1000),
});

export const updateSupplierSchema = createSupplierSchema
  .extend({ isActive: z.boolean() })
  .partial();

export const listSuppliersSchema = z.object({
  search: z.string().trim().max(100).optional(),
  active: z.stringbool().optional(),
});

export type CreateSupplierInput = z.infer<typeof createSupplierSchema>;
export type UpdateSupplierInput = z.infer<typeof updateSupplierSchema>;
export type ListSuppliersFilters = z.infer<typeof listSuppliersSchema>;
