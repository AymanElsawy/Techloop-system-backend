import { z } from 'zod';
import { CustomerStatus, CustomerType, GOVERNORATES } from './customer.types.js';

// Optional text: '' or null clears the field, undefined leaves it unchanged.
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v === '' ? null : v));

// Financial fields (debit, credit, lastInvoice, lastCollection) and status are
// deliberately absent: Zod strips unknown keys, so clients cannot set them.
export const createCustomerSchema = z.object({
  name: z.string().trim().min(2).max(120),
  type: z.enum(CustomerType).optional(),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ]{6,20}$/, 'Invalid phone number')
    .or(z.literal(''))
    .nullish()
    .transform((v) => (v === '' ? null : v)),
  contactPerson: optionalText(120),
  governorate: z.enum(GOVERNORATES),
  city: optionalText(80),
  address: optionalText(250),
  location: z
    .object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) })
    .nullish(),
  notes: optionalText(1000),
  // Managers only (checked in the service).
  creditLimit: z.number().nonnegative().nullish(),
  paymentTermDays: z.number().int().min(0).max(365).nullish(),
  discountPercent: z.number().min(0).max(100).nullish(),
});

export const updateCustomerSchema = createCustomerSchema.partial();

export const listCustomersSchema = z.object({
  governorate: z.enum(GOVERNORATES).optional(),
  status: z.enum(CustomerStatus).optional(),
  search: z.string().trim().max(100).optional(),
});

export const rejectCustomerSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;
export type ListCustomersFilters = z.infer<typeof listCustomersSchema>;
