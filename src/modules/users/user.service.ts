import { UserModel, type UserDocument } from './user.model.js';
import { UserRole } from './user.types.js';
import type { CreateUserInput, UpdateUserInput } from './user.validation.js';
import { hashPassword } from '../../utils/password.js';
import { AppError } from '../../utils/api-response.js';
import { assertCanChangeWarehouse, findActiveWarehouse } from '../inventory/inventory.service.js';

async function assertWarehouse(warehouse: string | null | undefined) {
  if (warehouse) await findActiveWarehouse(warehouse);
}

/** Every new user's first password; they must replace it on first login. */
export const DEFAULT_PASSWORD = '123456A';

export async function createUser(input: CreateUserInput) {
  await assertWarehouse(input.warehouse);
  return UserModel.create({
    ...input,
    password: await hashPassword(DEFAULT_PASSWORD),
    mustChangePassword: true,
  });
}

export function listUsers() {
  return UserModel.find().sort({ createdAt: -1 });
}

export async function getUserById(id: string) {
  const user = await UserModel.findById(id);
  if (!user) throw new AppError(404, 'User not found');
  return user;
}

// Only an owner may modify an owner account.
async function getEditableUser(id: string, actor: UserDocument) {
  const user = await getUserById(id);
  if (user.role === UserRole.OWNER && actor.role !== UserRole.OWNER) {
    throw new AppError(403, 'Forbidden');
  }
  return user;
}

export async function updateUser(id: string, input: UpdateUserInput, actor: UserDocument) {
  const user = await getEditableUser(id, actor);
  if (input.role && user.role === UserRole.OWNER) {
    throw new AppError(400, 'Owner role cannot be changed');
  }
  if (input.warehouse !== undefined && String(input.warehouse) !== String(user.warehouse)) {
    await assertWarehouse(input.warehouse);
    await assertCanChangeWarehouse(user._id);
  }
  const { password, ...rest } = input;
  user.set(rest);
  if (password) user.password = await hashPassword(password);
  return user.save();
}

export async function setUserStatus(id: string, isActive: boolean, actor: UserDocument) {
  if (actor.id === id) throw new AppError(400, 'You cannot change your own status');
  const user = await getEditableUser(id, actor);
  user.isActive = isActive;
  return user.save();
}
