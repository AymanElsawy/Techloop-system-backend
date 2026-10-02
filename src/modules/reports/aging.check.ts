// Self-check for the aging split and overdue amount. Run: npx tsx src/modules/reports/aging.check.ts
import assert from 'node:assert/strict';
import { ageDebt, bucketOf } from './report.service.js';
import { overdueOf } from '../customers/customer-balance.js';

const now = new Date('2026-09-30T12:00:00Z');
const ago = (d: number) => new Date(now.getTime() - d * 86_400_000);

assert.deepEqual([-1, 0, 30, 31, 60, 61, 90, 91].map(bucketOf), [0, 1, 1, 2, 2, 3, 3, 4]);

// No terms (no due date): age from the invoice date. Newest first: 10d 500, 45d 300, 100d 1000.
const noTerms = [
  { createdAt: ago(10), total: 500 },
  { createdAt: ago(45), total: 300 },
  { createdAt: ago(100), total: 1000 },
];
// Debt 700 -> 500 on the 10-day invoice, 200 on the 45-day one.
assert.deepEqual(ageDebt(700, noTerms, now), { buckets: [0, 500, 200, 0, 0], oldestDays: 45 });
assert.deepEqual(ageDebt(1800, noTerms, now).buckets, [0, 500, 300, 0, 1000]);
// More debt than invoices (shouldn't happen) lands in 90+.
assert.deepEqual(ageDebt(50, [], now).buckets, [0, 0, 0, 0, 50]);

// 30-day terms: sold 10 days ago -> not due; sold 45 days ago -> 15 days late.
const terms = [
  { createdAt: ago(10), total: 500, dueDate: ago(-20) },
  { createdAt: ago(45), total: 300, dueDate: ago(15) },
];
assert.deepEqual(ageDebt(800, terms, now), { buckets: [500, 300, 0, 0, 0], oldestDays: 15 });

// Overdue = only the part on invoices past their due date; no due date = never overdue.
assert.equal(overdueOf(800, terms, now), 300);
assert.equal(overdueOf(400, terms, now), 0); // paid down to the newest (not due) invoice
assert.equal(overdueOf(700, noTerms, now), 0);

console.log('aging + overdue OK');
