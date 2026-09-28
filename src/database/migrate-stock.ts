// One-off migration to warehouses: moves each product's old global `quantity` into a
// default warehouse, and points existing invoices at it. Safe to re-run.
import mongoose from 'mongoose';
import { connectDatabase } from '../config/database.js';
import { StockModel, WarehouseModel } from '../modules/inventory/inventory.model.js';
import { ProductModel } from '../modules/products/product.model.js';
import { InvoiceModel } from '../modules/invoices/invoice.model.js';

const DEFAULT_NAME = 'المخزن الرئيسي';

await connectDatabase();

const warehouse =
  (await WarehouseModel.findOne({ name: DEFAULT_NAME })) ??
  (await WarehouseModel.create({ name: DEFAULT_NAME }));

const products = ProductModel.collection;
const legacy = await products.find({ quantity: { $exists: true } }).toArray();
for (const p of legacy) {
  const quantity = Math.max(Number(p.quantity) || 0, 0); // negative stock is not carried over
  if (quantity > 0) {
    await StockModel.updateOne(
      { warehouse: warehouse._id, rep: null, product: p._id },
      { $inc: { quantity } },
      { upsert: true },
    );
  }
  await products.updateOne({ _id: p._id }, { $unset: { quantity: '' } });
}

const invoices = await InvoiceModel.collection.updateMany(
  { warehouse: { $exists: false } },
  { $set: { warehouse: warehouse._id, rep: null } },
);

console.log(
  `Warehouse "${DEFAULT_NAME}": moved ${legacy.length} products, updated ${invoices.modifiedCount} invoices.`,
);
await mongoose.disconnect();
