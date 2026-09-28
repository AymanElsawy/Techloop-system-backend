import { UserModel } from '../users/user.model.js';
import type { LoginInput } from './auth.validation.js';
import { comparePassword } from '../../utils/password.js';
import { signAccessToken } from '../../utils/jwt.js';
import { AppError } from '../../utils/api-response.js';

export async function login({ email, password }: LoginInput) {
  const user = await UserModel.findOne({ email: email.toLowerCase() }).select('+password');
  // Same message for unknown email and wrong password to avoid account enumeration.
  if (!user || !(await comparePassword(password, user.password))) {
    throw new AppError(401, 'Invalid credentials');
  }
  if (!user.isActive) throw new AppError(403, 'Account is disabled');

  user.lastLoginAt = new Date();
  await user.save();

  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      governorates: user.governorates,
    },
    accessToken: signAccessToken({ userId: user.id, role: user.role }),
  };
}
