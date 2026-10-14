// One-off: recompute every customer's balance after rep-held money started counting as paid.
// Only touches the derived summary fields (debit / credit / pendingPayments). Safe to re-run.
import mongoose from 'mongoose';
import { connectDatabase } from '../config/database.js';
import { CustomerModel } from '../modules/customers/customer.model.js';
import { syncCustomerSummary } from '../modules/customers/customer-balance.js';

await connectDatabase();
const customers = await CustomerModel.find().select('_id');
for (const c of customers) await syncCustomerSummary(c._id);
console.log(`Recomputed ${customers.length} customer balances.`);
await mongoose.disconnect();
