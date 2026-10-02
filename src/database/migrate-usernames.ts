// One-off migration from email login to username: each user without a username gets
// the part of their email before "@" (plus a number if taken). Safe to re-run.
import mongoose from 'mongoose';
import { connectDatabase } from '../config/database.js';
import { UserModel } from '../modules/users/user.model.js';

await connectDatabase();

const users = UserModel.collection;
// The old unique index would reject every new user (they have no email).
await users.dropIndex('email_1').catch(() => {});

const legacy = await users.find({ username: { $exists: false } }).toArray();
for (const u of legacy) {
  const base =
    String(u.email ?? '')
      .split('@')[0]
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '')
      .padEnd(3, '0')
      .slice(0, 28);
  let username = base;
  for (let n = 2; await users.findOne({ username }); n++) username = `${base}${n}`;
  await users.updateOne({ _id: u._id }, { $set: { username } });
  console.log(`${u.email} -> ${username}`);
}

await UserModel.syncIndexes();
console.log(`Gave ${legacy.length} users a username.`);
await mongoose.disconnect();
