import { z } from 'zod';
import { UserRole } from './user.types.js';
import { GOVERNORATES } from '../customers/customer.types.js';

// OWNER is never assignable through the API; the first owner comes from the seed script.
const assignableRole = z.enum([UserRole.ADMIN, UserRole.SALES_REP, UserRole.WAREHOUSE_REP]);

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._-]{3,30}$/, 'Use 3-30 English letters, digits, . _ -');

export const passwordSchema = z.string().min(8);

// No password: new users get DEFAULT_PASSWORD and set their own on first login.
export const createUserSchema = z.object({
  name: z.string().trim().min(2),
  username: usernameSchema,
  role: assignableRole,
  governorates: z
    .array(z.enum(GOVERNORATES))
    .max(GOVERNORATES.length)
    .transform((list) => [...new Set(list)])
    .optional(),
  warehouse: z
    .string()
    .regex(/^[0-9a-f]{24}$/i, 'Invalid id')
    .nullish(),
  salesTarget: z.number().min(0).nullish(),
  collectionTarget: z.number().min(0).nullish(),
  yearlySalesTarget: z.number().min(0).nullish(),
  yearlyCollectionTarget: z.number().min(0).nullish(),
  salesCommissionRate: z.number().min(0).max(100).optional(),
  collectionCommissionRate: z.number().min(0).max(100).optional(),
});

/** ?month=YYYY-MM or ?year=YYYY (year wins); neither = this month. */
export const periodSchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM')
    .optional(),
  year: z
    .string()
    .regex(/^\d{4}$/, 'Use YYYY')
    .optional(),
});

export const updateUserSchema = createUserSchema.partial().extend({ password: passwordSchema.optional() });

export const updateStatusSchema = z.object({
  isActive: z.boolean(),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
