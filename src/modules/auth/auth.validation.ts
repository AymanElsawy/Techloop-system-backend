import { z } from 'zod';
import { passwordSchema } from '../users/user.validation.js';

export const loginSchema = z.object({
  username: z.string().trim().toLowerCase().min(1),
  // Not min(8): the default password of a new user is shorter.
  password: z.string().min(1),
});

export const changePasswordSchema = z.object({ password: passwordSchema });

export type LoginInput = z.infer<typeof loginSchema>;
