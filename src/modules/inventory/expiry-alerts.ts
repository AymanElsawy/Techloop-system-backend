import { totalsByProduct } from './inventory.service.js';
import { ProductModel } from '../products/product.model.js';
import { EXPIRY_SOON, notify } from '../notifications/notification.service.js';

/** Same window as the "قريب الانتهاء" badge on web / mobile. */
const EXPIRY_WARNING_DAYS = 90;

/**
 * Tells managers once per expiry date about an in-stock product that expires within the window
 * (or already expired). Editing the date (a new batch) makes it eligible again.
 */
async function checkExpiry() {
  const soon = new Date(Date.now() + EXPIRY_WARNING_DAYS * 86_400_000);
  const products = await ProductModel.find({
    isActive: true,
    expiryDate: { $ne: null, $lte: soon },
    $expr: { $ne: ['$expiryAlertedFor', '$expiryDate'] },
  }).select('name expiryDate');
  if (!products.length) return;

  const totals = await totalsByProduct(products.map((p) => p._id));
  for (const p of products) {
    const quantity = totals.get(p.id as string) ?? 0;
    if (quantity <= 0) continue; // nothing to lose; checked again once stock comes in
    // Claim first, so overlapping runs can't alert twice.
    const claim = await ProductModel.updateOne(
      { _id: p._id, expiryAlertedFor: { $ne: p.expiryDate } },
      { expiryAlertedFor: p.expiryDate },
    );
    if (claim.modifiedCount)
      await notify(
        {
          type: EXPIRY_SOON,
          docId: p.id,
          number: null,
          party: p,
          quantity,
          expiryDate: p.expiryDate,
        },
        null,
      );
  }
}

// ponytail: in-process timer, same as backups; an expiry can show up to 6 hours late.
export function scheduleExpiryAlerts() {
  const check = () =>
    checkExpiry().catch((err: unknown) => console.error('Expiry alerts failed', err));
  setTimeout(check, 60_000); // let the server start first
  setInterval(check, 6 * 60 * 60_000).unref();
}
