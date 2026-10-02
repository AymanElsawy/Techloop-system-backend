import mongoose from 'mongoose';
import { connectDatabase } from '../config/database.js';
import { UserModel } from '../modules/users/user.model.js';
import { UserRole } from '../modules/users/user.types.js';
import { hashPassword } from '../utils/password.js';

const { SEED_OWNER_NAME = 'Company Owner', SEED_OWNER_USERNAME, SEED_OWNER_PASSWORD } = process.env;

if (!SEED_OWNER_USERNAME || !SEED_OWNER_PASSWORD) {
  console.error('SEED_OWNER_USERNAME and SEED_OWNER_PASSWORD must be set');
  process.exit(1);
}

await connectDatabase();

if (await UserModel.exists({ role: UserRole.OWNER })) {
  console.log('Owner already exists, skipping seed.');
} else {
  await UserModel.create({
    name: SEED_OWNER_NAME,
    username: SEED_OWNER_USERNAME,
    password: await hashPassword(SEED_OWNER_PASSWORD),
    role: UserRole.OWNER,
  });
  console.log(`Owner created: ${SEED_OWNER_USERNAME}`);
}

await mongoose.disconnect();
