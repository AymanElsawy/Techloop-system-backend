import { z } from 'zod';
import { UserRole } from './user.types.js';
import { GOVERNORATES } from '../customers/customer.types.js';

// OWNER is never assignable through the API; the first owner comes from the seed script.
const assignableRole = z.enum([UserRole.ADMIN, UserRole.SALES_REP]);

export const createUserSchema = z.object({
  name: z.string().trim().min(2),
  email: z.email(),
  password: z.string().min(8),
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
});

export const updateUserSchema = createUserSchema.partial();

export const updateStatusSchema = z.object({
  isActive: z.boolean(),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
