import { UserModel, type UserDocument } from '../users/user.model.js';
import { DEFAULT_PASSWORD } from '../users/user.service.js';
import type { LoginInput } from './auth.validation.js';
import { comparePassword, hashPassword } from '../../utils/password.js';
import { signAccessToken } from '../../utils/jwt.js';
import { AppError } from '../../utils/api-response.js';

/** The logged-in user as login, /auth/me and change-password return it. */
export function sessionUser(user: UserDocument) {
  const { id, name, username, role, governorates, mustChangePassword } = user;
  return { id, name, username, role, governorates, mustChangePassword };
}

export async function login({ username, password }: LoginInput) {
  const user = await UserModel.findOne({ username }).select('+password');
  // Same message for unknown username and wrong password to avoid account enumeration.
  if (!user || !(await comparePassword(password, user.password))) {
    throw new AppError(401, 'Invalid credentials');
  }
  if (!user.isActive) throw new AppError(403, 'Account is disabled');

  user.lastLoginAt = new Date();
  await user.save();

  return {
    user: sessionUser(user),
    accessToken: signAccessToken({ userId: user.id, role: user.role }),
  };
}

/** First-login password change; the only one a user does themselves. */
export async function changePassword(user: UserDocument, password: string) {
  if (!user.mustChangePassword) throw new AppError(400, 'Password change not required');
  if (password === DEFAULT_PASSWORD) throw new AppError(400, 'Choose a different password');
  user.password = await hashPassword(password);
  user.mustChangePassword = false;
  await user.save();
  return sessionUser(user);
}
