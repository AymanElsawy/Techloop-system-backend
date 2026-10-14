/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed API responses in a dev script */
/**
 * Demo data (development only): wipes every collection except the company settings, then fills
 * the system through the running API (so stock, balances and the treasury stay consistent),
 * moving each simulated day back in time. Needs the backend running on API_URL.
 *   npm run seed:demo
 */
import mongoose from 'mongoose';
import { connectDatabase } from '../config/database.js';
import { UserModel } from '../modules/users/user.model.js';
import { UserRole } from '../modules/users/user.types.js';
import { CustomerModel } from '../modules/customers/customer.model.js';
import { syncCustomerSummary } from '../modules/customers/customer-balance.js';
import { hashPassword } from '../utils/password.js';
import { env } from '../config/env.js';

if (env.NODE_ENV === 'production') throw new Error('Demo seed is for development only');

const API = process.env.API_URL ?? `http://localhost:${env.PORT}/api`;
const PASSWORD = 'NewPass456!';
const { SEED_OWNER_USERNAME = 'owner', SEED_OWNER_PASSWORD = 'Password123!' } = process.env;

// ---------- helpers ----------
let seed = 20261002;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
const pick = <T>(list: T[]) => list[Math.floor(rand() * list.length)]!;
const sample = <T>(list: T[], n: number) => [...list].sort(() => rand() - 0.5).slice(0, n);
const chance = (p: number) => rand() < p;
const round2 = (n: number) => Math.round(n * 100) / 100;
const DAY = 86_400_000;
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

type Session = { token: string; label: string };
const log = { ok: 0, skipped: [] as string[] };

async function api<T = any>(s: Session, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { data?: T; message?: string };
  if (!res.ok) throw new Error(`${method} ${path} (${s.label}): ${res.status} ${json.message ?? ''}`);
  log.ok++;
  return json.data as T;
}

/** Runs a business step that the API may legitimately refuse (stock, debt, overdue...). */
async function attempt<T>(what: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    log.skipped.push(`${what}: ${(err as Error).message}`);
    return null;
  }
}

async function login(username: string, password: string): Promise<Session> {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const json = (await res.json()) as { data: { accessToken: string } };
  if (!res.ok) throw new Error(`Login failed for ${username}: ${JSON.stringify(json)}`);
  return { token: json.data.accessToken, label: username };
}

// Every date the server stamps with "now". Shifting them moves a whole simulated day into the past.
const STAMPS = [
  'createdAt', 'updatedAt', 'dueDate', 'depositedAt', 'chequeStatusAt', 'cancelledAt',
  'lastPurchaseAt', 'reviewedAt', 'startedAt', 'completedAt', 'readAt',
];

/** Moves everything stamped since `since` so that `since` becomes `to`. */
async function shiftSince(since: Date, to: Date) {
  const delta = since.getTime() - to.getTime();
  if (delta <= 0) return;
  const set = Object.fromEntries(
    STAMPS.map((f) => [f, { $cond: [{ $gte: [`$${f}`, since] }, { $subtract: [`$${f}`, delta] }, `$${f}`] }]),
  );
  for (const c of await mongoose.connection.db!.collections()) {
    await c.updateMany({ $or: STAMPS.map((f) => ({ [f]: { $gte: since } })) }, [{ $set: set }]);
  }
}

/** Runs one simulated day `daysAgo` days back (at `hour`), then moves its records there. */
async function day(daysAgo: number, hour: number, fn: () => Promise<void>) {
  const to = new Date(Date.now() - daysAgo * DAY);
  to.setHours(hour, int(0, 59), 0, 0);
  const since = new Date();
  await fn();
  if (to < since) await shiftSince(since, to);
}

// ---------- 1. wipe + owner ----------
await connectDatabase();
for (const c of await mongoose.connection.db!.collections()) {
  if (c.collectionName === 'companysettings') continue; // company settings are configuration, not data
  await c.deleteMany({});
}
await UserModel.create({
  name: 'م. أحمد الشريف',
  username: SEED_OWNER_USERNAME,
  password: await hashPassword(SEED_OWNER_PASSWORD),
  role: UserRole.OWNER,
});
const owner = await login(SEED_OWNER_USERNAME, SEED_OWNER_PASSWORD);
console.log('Database wiped, owner created.');

// ---------- 2. master data (dated ~4 months back) ----------
const REGIONS = [
  { name: 'القاهرة الكبرى', warehouse: 'مخزن القاهرة', govs: ['القاهرة', 'الجيزة', 'القليوبية'] },
  { name: 'شرق الدلتا', warehouse: 'مخزن المنصورة', govs: ['الدقهلية', 'الشرقية', 'الغربية'] },
  { name: 'غرب الدلتا', warehouse: 'مخزن الإسكندرية', govs: ['الإسكندرية', 'البحيرة', 'كفر الشيخ'] },
  { name: 'القناة', warehouse: 'مخزن الإسماعيلية', govs: ['الإسماعيلية', 'السويس', 'بورسعيد'] },
  { name: 'الصعيد', warehouse: 'مخزن أسيوط', govs: ['المنيا', 'أسيوط', 'سوهاج'] },
];
const REP_NAMES = [
  'محمد عبد الله', 'أحمد سمير', 'محمود حسن', 'كريم فتحي',
  'إسلام عادل', 'مصطفى رجب', 'عمرو السيد', 'هشام نبيل',
  'يوسف مجدي', 'شريف عاطف', 'وليد صلاح', 'تامر الجندي',
  'حسام شوقي', 'أيمن بدوي', 'رامي منصور', 'خالد عزت',
  'إبراهيم قناوي', 'عصام الصعيدي', 'جمال حمدان', 'سعيد عبد الرحيم',
];
const STOREKEEPERS = ['عبد الرحمن فؤاد', 'سامح لطفي', 'ناصر الشاذلي', 'مدحت عزمي', 'رضا حمودة'];

type Rep = { id: string; name: string; username: string; region: number; s?: Session; seq: number; rseq: number };
const warehouses: { id: string; name: string; keeper?: Session }[] = [];
const reps: Rep[] = [];
const suppliers: { id: string; name: string }[] = [];
const products: { id: string; name: string; price: number; cost: number }[] = [];
const customers: { id: string; name: string; region: number; termDays: number | null; limit: number | null; discount: number }[] = [];

const masterStart = new Date();
const masterTo = new Date(Date.now() - 120 * DAY);
masterTo.setHours(9, 0, 0, 0);

await api(owner, 'POST', '/users', { name: 'منى الحسيني', username: 'admin', role: UserRole.ADMIN });

for (const r of REGIONS) {
  const w = await api(owner, 'POST', '/inventory/warehouses', { name: r.warehouse, notes: `مخزن منطقة ${r.name} (${r.govs.join('، ')})` });
  warehouses.push({ id: w.id, name: w.name });
}
for (const [i, r] of REGIONS.entries()) {
  await api(owner, 'POST', '/users', {
    name: STOREKEEPERS[i], username: `store${String(i + 1).padStart(2, '0')}`,
    role: UserRole.WAREHOUSE_REP, warehouse: warehouses[i]!.id, governorates: r.govs,
  });
}
for (let i = 0; i < 20; i++) {
  const region = Math.floor(i / 4);
  const username = i === 0 ? 'rep' : `rep${String(i + 1).padStart(2, '0')}`;
  // Targets: monthly only, yearly only, both, or none; commission rates vary.
  const kind = i % 4;
  const u = await api(owner, 'POST', '/users', {
    name: REP_NAMES[i], username, role: UserRole.SALES_REP,
    governorates: REGIONS[region]!.govs, warehouse: warehouses[region]!.id,
    salesTarget: kind === 0 || kind === 2 ? int(6, 12) * 10_000 : null,
    collectionTarget: kind === 0 || kind === 2 ? int(4, 9) * 10_000 : null,
    yearlySalesTarget: kind === 1 || kind === 2 ? int(8, 14) * 100_000 : null,
    yearlyCollectionTarget: kind === 1 ? int(6, 10) * 100_000 : null,
    salesCommissionRate: kind === 3 ? 0 : pick([1, 1.5, 2, 2.5]),
    collectionCommissionRate: kind === 3 ? 0 : pick([0.5, 1]),
  });
  reps.push({ id: u.id, name: u.name, username, region, seq: 0, rseq: 0 });
}
// Every user gets a known password and skips the first-login password change.
await UserModel.updateMany(
  { role: { $ne: UserRole.OWNER } },
  { password: await hashPassword(PASSWORD), mustChangePassword: false },
);
for (const [i, w] of warehouses.entries()) w.keeper = await login(`store${String(i + 1).padStart(2, '0')}`, PASSWORD);
for (const r of reps) r.s = await login(r.username, PASSWORD);

const SUPPLIERS = [
  { name: 'الشركة المصرية للأدوية البيطرية', company: 'Egyvet', phone: '0225123456', address: 'العاشر من رمضان' },
  { name: 'فارما سويس للأدوية', company: 'Pharma Swiss', phone: '0233456789', address: 'السادس من أكتوبر' },
  { name: 'المتحدة للمستلزمات البيطرية', company: 'United Vet', phone: '0403221144', address: 'طنطا' },
  { name: 'النيل للتوكيلات', company: 'Nile Agencies', phone: '0222667788', address: 'مدينة نصر' },
  { name: 'الدلتا فارم', company: 'Delta Pharm', phone: '0502334455', address: 'المنصورة' },
  { name: 'أطلس للأمصال واللقاحات', company: 'Atlas Vaccines', phone: '0238899001', address: 'الشيخ زايد', notes: 'لقاحات بتتشحن مبردة' },
];
for (const s of SUPPLIERS) suppliers.push(await api(owner, 'POST', '/suppliers', s));
const sup = (i: number) => suppliers[i]!.id;

const soon = (days: number) => isoDate(new Date(Date.now() + days * DAY));
const PRODUCTS = [
  { name: 'إيفرمكتين 1% حقن 50 مل', code: 'IVM-50', unit: 'PACK', price: 95, cost: 62, supplier: 0, min: 60, manufacturer: 'Egyvet', expiry: soon(540) },
  { name: 'أوكسي تتراسيكلين 20% LA حقن 100 مل', code: 'OTC-LA', unit: 'PACK', price: 140, cost: 92, supplier: 1, min: 50, manufacturer: 'Pharma Swiss', expiry: soon(400) },
  { name: 'إنروفلوكساسين 10% محلول فموي', code: 'ENR-1L', unit: 'LITER', price: 420, cost: 300, supplier: 0, min: 30, manufacturer: 'Egyvet', expiry: soon(25) },
  { name: 'أموكسيسيلين 50% بودرة 100 جم', code: 'AMX-100', unit: 'PACK', price: 75, cost: 48, supplier: 2, min: 80, manufacturer: 'United Vet', expiry: soon(300) },
  { name: 'فيتامين AD3E حقن 100 مل', code: 'AD3E', unit: 'PACK', price: 60, cost: 36, supplier: 3, min: 50, manufacturer: 'Nile', expiry: soon(700) },
  { name: 'كالسيوم بوروجلوكونات 500 مل', code: 'CAL-500', unit: 'PACK', price: 85, cost: 55, supplier: 4, min: 40, manufacturer: 'Delta Pharm', expiry: soon(12) },
  { name: 'ألبندازول 10% معلق لتر', code: 'ALB-1L', unit: 'LITER', price: 260, cost: 170, supplier: 1, min: 25, manufacturer: 'Pharma Swiss', expiry: soon(450) },
  { name: 'فلونيكسين ميجلومين حقن 50 مل', code: 'FLU-50', unit: 'PACK', price: 115, cost: 80, supplier: 1, min: 30, manufacturer: 'Pharma Swiss', expiry: soon(600) },
  { name: 'تيلوزين 20% حقن 100 مل', code: 'TYL-20', unit: 'PACK', price: 130, cost: 88, supplier: 2, min: 40, manufacturer: 'United Vet', expiry: soon(380) },
  { name: 'تولترازوريل 2.5% مضاد كوكسيديا لتر', code: 'TOL-1L', unit: 'LITER', price: 510, cost: 360, supplier: 4, min: 20, manufacturer: 'Delta Pharm', expiry: soon(500) },
  { name: 'مطهر جلوتارالدهيد 5 لتر', code: 'GLU-5L', unit: 'CARTON', price: 650, cost: 470, supplier: 3, min: 10, manufacturer: 'Nile', expiry: null },
  { name: 'لقاح نيوكاسل هتشنر 1000 جرعة', code: 'NDV-1000', unit: 'PACK', price: 55, cost: 34, supplier: 5, min: 100, manufacturer: 'Atlas', expiry: soon(60) },
  { name: 'لقاح جمبورو 1000 جرعة', code: 'IBD-1000', unit: 'PACK', price: 65, cost: 41, supplier: 5, min: 100, manufacturer: 'Atlas', expiry: soon(-5) },
  { name: 'دوكسيسيكلين 50% بودرة 100 جم', code: 'DOX-100', unit: 'PACK', price: 90, cost: 58, supplier: 0, min: 60, manufacturer: 'Egyvet', expiry: soon(320) },
  { name: 'أملاح معدنية وفيتامينات 1 كجم', code: null, unit: null, price: 45, cost: 27, supplier: null, min: null, manufacturer: null, expiry: null },
  { name: 'سيفتيوفور 5% حقن 100 مل', code: 'CEF-5', unit: 'PACK', price: 230, cost: 160, supplier: 1, min: 20, manufacturer: 'Pharma Swiss', expiry: soon(420) },
];
for (const p of PRODUCTS) {
  const created = await api(owner, 'POST', '/products', {
    name: p.name, code: p.code, unit: p.unit, price: p.price, lastCost: p.cost,
    supplierId: p.supplier == null ? null : sup(p.supplier), minQuantity: p.min,
    manufacturer: p.manufacturer, expiryDate: p.expiry,
    notes: p.expiry && p.expiry < soon(0) ? 'تشغيلة منتهية: لازم ترجع للمورد' : null,
  });
  products.push({ id: created.id, name: p.name, price: p.price, cost: p.cost });
}
// A product created with its opening stock in one go (credit purchase from its supplier).
const opening = await api(owner, 'POST', '/products', {
  name: 'بنسلين ستربتومايسين حقن', code: 'PEN-STR', unit: 'PACK', price: 50, lastCost: 30,
  supplierId: sup(2), minQuantity: 40, manufacturer: 'United Vet', expiryDate: soon(365),
  stock: { warehouseId: warehouses[0]!.id, quantity: 300, unitCost: 30, paidAmount: 0 },
});
products.push({ id: opening.id, name: opening.name, price: 50, cost: 30 });
// An inactive (discontinued) product with no stock.
const old = await api(owner, 'POST', '/products', { name: 'سلفا كينوكسالين (موقوف)', code: 'SQX-OLD', unit: 'PACK', price: 40, lastCost: 25, supplierId: sup(3) });
await api(owner, 'PATCH', `/products/${old.id}`, { isActive: false, notes: 'اتوقف إنتاجه' });

const CUSTOMER_NAMES = [
  ['عيادة الرحمة البيطرية', 'CLINIC'], ['مزرعة الأمل للدواجن', 'FARM'], ['صيدلية النور البيطرية', 'PHARMACY'], ['مؤسسة الفتح للتجارة', 'TRADER'],
  ['مزرعة الوادي للمواشي', 'FARM'], ['صيدلية الشفاء البيطرية', 'PHARMACY'], ['عيادة د. سامي البيطرية', 'CLINIC'], ['شركة الدلتا للإنتاج الحيواني', 'TRADER'],
  ['مزارع الساحل للدواجن', 'FARM'], ['صيدلية الحياة البيطرية', 'PHARMACY'], ['عيادة المحمودية البيطرية', 'CLINIC'], ['مركز البحيرة للأعلاف', 'OTHER'],
  ['مزرعة القناة للدواجن', 'FARM'], ['صيدلية السلام البيطرية', 'PHARMACY'], ['عيادة بورسعيد البيطرية', 'CLINIC'], ['مؤسسة السويس الزراعية', 'TRADER'],
  ['مزرعة الصعيد للمواشي', 'FARM'], ['صيدلية الهدى البيطرية', 'PHARMACY'], ['عيادة أسيوط البيطرية', 'CLINIC'], ['مؤسسة سوهاج للتوريدات', 'TRADER'],
] as const;
// Payment terms, credit limits and discounts cover: none, short, long, tight limit, discount.
const TERMS = [30, null, 45, 15, 60, 30, null, 90, 30, 45, 15, null, 60, 30, 45, null, 30, 15, null, 60];
const LIMITS = [50_000, null, 80_000, 15_000, 120_000, 40_000, null, 200_000, 60_000, 30_000, 8_000, null, 100_000, 45_000, 25_000, null, 70_000, 20_000, null, 90_000];
const DISCOUNTS = [0, 0, 5, 3, 0, 2, 0, 7, 5, 0, 0, 2, 3, 0, 0, 5, 0, 2, 0, 3];

for (const [i, [name, type]] of CUSTOMER_NAMES.entries()) {
  const region = Math.floor(i / 4);
  const gov = REGIONS[region]!.govs[i % 3]!;
  const body = {
    name, type, governorate: gov, city: gov, phone: `010${String(10_000_000 + i * 7_654_321).slice(0, 8)}`,
    contactPerson: pick(['د. هاني', 'أ. سعد', 'د. ريم', 'م. طارق', 'أ. فاطمة']),
    address: `شارع ${pick(['الجمهورية', 'الجلاء', 'البحر', 'المحطة', 'السوق'])}، ${gov}`,
    location: { latitude: round2(30 + rand() * 1.5), longitude: round2(31 + rand() * 1.2) },
  };
  const terms = { creditLimit: LIMITS[i], paymentTermDays: TERMS[i], discountPercent: DISCOUNTS[i] };
  // The last customer of regions 3, 4 and 5 is added by a rep: approved later, left pending, rejected.
  const byRep = i === 11 || i === 15 || i === 19;
  const repOf = reps[region * 4]!;
  const c = byRep
    ? await api(repOf.s!, 'POST', '/customers', { ...body, notes: 'عميل جديد ضافه المندوب' })
    : await api(owner, 'POST', '/customers', { ...body, ...terms });
  if (i === 11) {
    await api(owner, 'PATCH', `/customers/${c.id}`, terms);
    await api(owner, 'PATCH', `/customers/${c.id}/approve`);
  }
  if (i === 19) await api(owner, 'PATCH', `/customers/${c.id}/reject`, { reason: 'بيانات العميل ناقصة ورقم التليفون غلط' });
  customers.push({ id: c.id, name, region, termDays: byRep && i !== 11 ? null : TERMS[i]!, limit: byRep && i !== 11 ? null : LIMITS[i]!, discount: byRep && i !== 11 ? 0 : DISCOUNTS[i]! });
}
// Pending/rejected customers are not sold to by the demo (except one pending order below).
const activeCustomers = customers.filter((_, i) => i !== 15 && i !== 19);
await shiftSince(masterStart, masterTo);
console.log('Users, warehouses, suppliers, products and customers created.');

// ---------- 3. business timeline ----------
const regionCustomers = (region: number) => activeCustomers.filter((c) => c.region === region);
const wh = (region: number) => warehouses[region]!;
const P = (code: number) => products[code]!;

/** A purchase receipt: `lines` are [productIndex, quantity, unitCost]. */
const receive = (region: number, supplier: number, lines: [number, number, number][], paid: number | 'all', notes?: string) =>
  attempt(`receive ${wh(region).name}`, () => {
    const total = lines.reduce((s, [, q, c]) => s + q * c, 0);
    return api(owner, 'POST', `/inventory/warehouses/${wh(region).id}/receive`, {
      supplierId: sup(supplier),
      items: lines.map(([p, quantity, unitCost]) => ({ productId: P(p).id, quantity, unitCost })),
      paidAmount: paid === 'all' ? total : paid,
      notes: notes ?? null,
    });
  });

/** Issue custody from the region's warehouse to a rep (done by the storekeeper). */
const issue = (rep: Rep, lines: [number, number][]) =>
  attempt(`issue to ${rep.username}`, () =>
    api(wh(rep.region).keeper!, 'POST', `/inventory/warehouses/${wh(rep.region).id}/issue`, {
      repId: rep.id,
      items: lines.map(([p, quantity]) => ({ productId: P(p).id, quantity })),
      notes: 'صرف عهدة',
    }),
  );

const METHODS = ['CASH', 'CASH', 'CASH', 'VODAFONE_CASH', 'BANK_TRANSFER', 'CHEQUE'] as const;
const payment = (method: string) =>
  method === 'CHEQUE'
    ? { paymentMethod: method, chequeNumber: String(int(100000, 999999)), chequeDueDate: soon(int(5, 40)) }
    : { paymentMethod: method };

/** A rep's sale; falls back to cash in full when the API refuses credit (limit or overdue). */
async function repSale(rep: Rep, customer: (typeof customers)[number], visitId?: string) {
  const lines = sample([...products.keys()], int(1, 4)).map((p) => ({
    productId: P(p).id,
    quantity: int(2, 15),
    // Sometimes the rep sells at a different price than the list price.
    ...(chance(0.15) && { unitPrice: round2(P(p).price * pick([0.95, 0.9, 1.05])) }),
  }));
  const est = round2(
    lines.reduce((s, l) => {
      const price = round2(l.unitPrice ?? products.find((p) => p.id === l.productId)!.price);
      return s + round2(price * l.quantity * (1 - customer.discount / 100));
    }, 0),
  );
  const mode = pick(['credit', 'credit', 'partial', 'full', 'full']);
  const method = pick([...METHODS]);
  const paid = mode === 'credit' ? 0 : mode === 'partial' ? Math.floor(est * pick([0.3, 0.5])) : Math.floor(est);
  rep.seq++;
  const base = {
    invoiceNumber: `${rep.username.toUpperCase()}-${String(rep.seq).padStart(4, '0')}`,
    customerId: customer.id, visitId: visitId ?? null, items: lines,
    notes: chance(0.2) ? pick(['التسليم في المزرعة', 'العميل طلب فاتورة ضريبية', 'تم التسليم للدكتور']) : null,
  };
  const body = paid > 0 ? { ...base, paidAmount: paid, ...payment(method) } : base;
  try {
    return await api(rep.s!, 'POST', '/invoices', body);
  } catch (err) {
    const msg = (err as Error).message;
    if (!/Credit limit|overdue/i.test(msg)) {
      log.skipped.push(`sale ${rep.username}: ${msg}`);
      return null;
    }
    // Customer is over the limit or late: cash only.
    return attempt(`cash sale ${rep.username}`, () =>
      api(rep.s!, 'POST', '/invoices', { ...base, invoiceNumber: `${base.invoiceNumber}C`, paidAmount: est, paymentMethod: 'CASH', notes: 'كاش بس: العميل عليه متأخرات أو عدى حد الائتمان' }),
    );
  }
}

async function collect(by: Session, customerId: string, receipt: string, share: number, method: string, visitId?: string) {
  const c = await api(owner, 'GET', `/customers/${customerId}`);
  const debt = c.debit ?? 0;
  const amount = Math.floor(debt * share);
  if (amount < 50) return null;
  return attempt(`collection ${receipt}`, () =>
    api(by, 'POST', '/collections', { receiptNumber: receipt, customerId, visitId: visitId ?? null, amount, ...payment(method) }),
  );
}

/** Manager receives a rep's cash box (some or all of it) plus their pending expenses. */
async function handover(rep: Rep, all = true) {
  const pending = await api<{ kind: string; id: string }[]>(owner, 'GET', `/treasury/pending?repId=${rep.id}`);
  if (!pending.length) return;
  const chosen = all ? pending : pending.slice(0, Math.ceil(pending.length / 2));
  const expenses = await api<{ id: string }[]>(owner, 'GET', `/treasury/entries?repId=${rep.id}&pending=true`);
  await attempt(`deposit ${rep.username}`, () =>
    api(owner, 'POST', '/treasury/deposits', {
      repId: rep.id,
      invoiceIds: chosen.filter((p) => p.kind === 'INVOICE').map((p) => p.id),
      collectionIds: chosen.filter((p) => p.kind === 'COLLECTION').map((p) => p.id),
      expenseIds: all ? expenses.map((e) => e.id) : [],
      notes: all ? 'تسليم عهدة نقدية كاملة' : 'تسليم جزئي',
    }),
  );
}

/** One rep working day: visits, sales, collections, sometimes an expense or a customer return. */
async function repDay(rep: Rep, futureVisit: boolean) {
  const customer = pick(regionCustomers(rep.region));
  const purpose = pick(['SALE', 'SALE', 'COLLECTION', 'FOLLOW_UP']);
  const visit = await attempt(`visit ${rep.username}`, () =>
    api(rep.s!, 'POST', '/visits', { customerId: customer.id, purpose, scheduledAt: new Date().toISOString() }),
  );
  if (!visit) return;
  if (chance(0.1)) {
    await api(rep.s!, 'POST', `/visits/${visit.id}/cancel`, { reason: 'العميل مش موجود' });
    return;
  }
  await api(rep.s!, 'POST', `/visits/${visit.id}/start`, {});
  if (purpose !== 'COLLECTION') await repSale(rep, customer, visit.id);
  if (purpose !== 'SALE' || chance(0.3)) {
    rep.rseq++;
    await collect(rep.s!, customer.id, `${rep.username.toUpperCase()}-R${String(rep.rseq).padStart(3, '0')}`, pick([0.2, 0.4, 0.6, 1]), pick([...METHODS]), visit.id);
  }
  await api(rep.s!, 'POST', `/visits/${visit.id}/complete`, {
    notes: pick(['الزيارة تمت', 'العميل محتاج عروض أسعار', 'طلب كميات أكبر الشهر الجاي', null]),
    productsDiscussed: sample(products, 2).map((p) => p.name),
    customerFeedback: pick(['راضي عن الأسعار', 'بيشتكي من التأخير', 'عايز خصم أكبر', null]),
    nextVisitAt: futureVisit ? new Date(Date.now() + 14 * DAY).toISOString() : null,
  });
  // A second sale outside any visit.
  if (chance(0.35)) await repSale(rep, pick(regionCustomers(rep.region)));
  const amount = pick([50, 80, 120, 200, 350]);
  if (chance(0.3) && (await api(rep.s!, 'GET', '/treasury/cash-box')).cash >= amount) {
    await attempt(`expense ${rep.username}`, () =>
      api(rep.s!, 'POST', '/treasury/entries', { amount, category: pick(['بنزين', 'مواصلات', 'أكل', 'صيانة عربية']), notes: null }),
    );
  }
}

/** A customer return on one of the rep's recent invoices (partial or the whole line). */
async function repReturn(rep: Rep) {
  const invoices = await api<any[]>(rep.s!, 'GET', '/invoices');
  const inv = invoices.find((i) => i.status === 'ACTIVE' && i.items.length);
  if (!inv) return null;
  const line = pick(inv.items as any[]);
  const productId = line.product?.id ?? line.product;
  return attempt(`return ${rep.username}`, () =>
    api(rep.s!, 'POST', '/returns', {
      invoiceId: inv.id,
      items: [{ productId, quantity: chance(0.5) ? line.quantity : Math.max(1, Math.floor(line.quantity / 2)) }],
      notes: pick(['عبوات تالفة', 'العميل طلب كمية زيادة', 'قرب ميعاد الصلاحية']),
    }),
  );
}

// Day -110: opening purchases into every warehouse, the same products from different suppliers
// and prices (credit, paid later). Before 30/9 receipts don't leave the treasury, so they're unpaid.
await day(110, 10, async () => {
  for (let r = 0; r < 5; r++) {
    await receive(r, 0, [[0, 250, 60], [2, 160, 295], [13, 200, 57]], 0, 'رصيد افتتاحي');
    await receive(r, 1, [[1, 200, 90], [6, 160, 168], [7, 120, 79], [15, 140, 158]], 0);
    await receive(r, 2, [[3, 300, 47], [8, 150, 86], [16, 150, 30]], 0);
    await receive(r, 3, [[4, 250, 35], [10, 130, 465], [14, 400, 26], [0, 100, 63]], 0, 'نفس الصنف من مورد تاني بسعر مختلف');
    await receive(r, 4, [[5, 150, 54], [9, 140, 355], [3, 100, 49]], 0);
    await receive(r, 5, [[11, 500, 33], [12, 400, 40]], 0, 'لقاحات مبردة');
  }
});

// Day -105: custody issued to every rep.
await day(105, 9, async () => {
  for (const rep of reps) {
    await issue(rep, sample([...products.keys()], 6).map((p) => [p, int(10, 30)] as [number, number]));
  }
});

// Sales days spread over ~3.5 months.
const SALES_DAYS = [100, 93, 86, 79, 72, 65, 58, 51, 44, 37, 30, 23, 16, 10, 6, 3, 2];
for (const d of SALES_DAYS) {
  await day(d, 11, async () => {
    for (const rep of sample(reps, 12)) await repDay(rep, d <= 6);
  });

  if (d === 86) {
    // Restock: same products again from other suppliers at new prices (average cost moves).
    await day(85, 14, async () => {
      await receive(0, 4, [[0, 150, 66], [1, 100, 95]], 0, 'توريد إضافي');
      await receive(1, 2, [[2, 40, 310], [4, 120, 38]], 0);
      await receive(2, 0, [[3, 150, 46], [8, 80, 90]], 0);
    });
    // Transfer between warehouses and a stock count (shortage + surplus).
    await day(84, 12, async () => {
      await attempt('transfer', () =>
        api(owner, 'POST', `/inventory/warehouses/${wh(0).id}/transfer`, {
          toWarehouseId: wh(4).id, items: [{ productId: P(10).id, quantity: 10 }, { productId: P(14).id, quantity: 60 }], notes: 'عجز في مخزن أسيوط',
        }),
      );
      const stock = await api<any>(owner, 'GET', `/inventory/warehouses/${wh(1).id}`);
      const rows = stock.stock as any[];
      const qty = (pid: string) => rows.find((s) => (s.product?.id ?? s.product) === pid)?.quantity ?? 0;
      await attempt('adjust', () =>
        api(owner, 'POST', `/inventory/warehouses/${wh(1).id}/adjust`, {
          items: [{ productId: P(4).id, counted: Math.max(qty(P(4).id) - 3, 0) }, { productId: P(14).id, counted: qty(P(14).id) + 2 }],
          reason: 'جرد ربع سنوي: 3 عبوات مكسورة و2 زيادة',
        }),
      );
    });
  }
  if (d === 65 || d === 37) {
    // Top up custody; storekeepers take back slow items from a few reps.
    await day(d - 1, 9, async () => {
      for (const rep of sample(reps, 10)) await issue(rep, sample([...products.keys()], 4).map((p) => [p, int(8, 20)] as [number, number]));
      for (const rep of sample(reps, 4)) {
        const my = await api<{ custody: any[] }>(rep.s!, 'GET', '/inventory/my-stock');
        const items = my.custody.filter((s) => s.quantity > 2).slice(0, 2);
        if (items.length)
          await attempt(`custody return ${rep.username}`, () =>
            api(wh(rep.region).keeper!, 'POST', `/inventory/warehouses/${wh(rep.region).id}/return`, {
              repId: rep.id,
              items: items.map((s) => ({ productId: s.product?.id ?? s.product, quantity: Math.floor(s.quantity / 2) })),
              notes: 'مرتجع عهدة: أصناف راكدة',
            }),
          );
      }
    });
  }
  if ([79, 58, 37, 16].includes(d)) {
    // Handovers: some reps hand over everything, one only part; the rest keep cash on them.
    await day(d - 1, 16, async () => {
      for (const rep of sample(reps, 14)) await handover(rep, chance(0.85));
    });
  }
  if (d === 72 || d === 30 || d === 10) {
    await day(d - 1, 13, async () => {
      for (const rep of sample(reps, 4)) await repReturn(rep);
    });
  }
  if (d === 51) {
    await day(50, 12, async () => {
      // The owner sells directly from a warehouse (big order, cheque), and collects directly.
      const big = customers[7]!;
      await attempt('owner sale', () =>
        api(owner, 'POST', '/invoices', {
          invoiceNumber: 'HQ-0001', customerId: big.id, warehouseId: wh(1).id,
          items: [{ productId: P(9).id, quantity: 20, discountPercent: 10 }, { productId: P(10).id, quantity: 8 }],
          paidAmount: 5000, ...payment('CHEQUE'), notes: 'طلبية مباشرة من الإدارة',
        }),
      );
      await collect(owner, customers[0]!.id, 'HQ-R001', 0.5, 'BANK_TRANSFER');
      // Sale to the pending customer (not approved yet).
      await repSale(reps[12]!, customers[15]!);
    });
  }
}

// Cancellations: an invoice, a collection and a return.
await day(20, 15, async () => {
  const invs = await api<any[]>(reps[1]!.s!, 'GET', '/invoices');
  const inv = invs.find((i) => i.status === 'ACTIVE' && !i.paidAmount);
  if (inv) await attempt('cancel invoice', () => api(owner, 'PATCH', `/invoices/${inv.id}/cancel`, { reason: 'الفاتورة اتكتبت غلط' }));
  const cols = await api<any[]>(owner, 'GET', '/collections');
  const col = cols.find((c) => c.status === 'ACTIVE');
  if (col) await attempt('cancel collection', () => api(owner, 'PATCH', `/collections/${col.id}/cancel`, { reason: 'إيصال مكرر' }));
  const rets = await api<any[]>(owner, 'GET', '/returns');
  const ret = rets.find((r) => r.status === 'ACTIVE');
  if (ret) await attempt('cancel return', () => api(owner, 'PATCH', `/returns/${ret.id}/cancel`, { reason: 'المرتجع اتسجل بالغلط' }));
  // A manager return into a different warehouse than the invoice's.
  const all = await api<any[]>(owner, 'GET', '/invoices');
  const target = all.find((i) => i.status === 'ACTIVE' && i.items.length > 1);
  if (target) {
    const line = target.items[0];
    await attempt('manager return', () =>
      api(owner, 'POST', '/returns', {
        invoiceId: target.id, warehouseId: wh(0).id,
        items: [{ productId: line.product?.id ?? line.product, quantity: 1 }], notes: 'مرتجع للمخزن الرئيسي',
      }),
    );
  }
});

// Cheques that reached the treasury: most clear, one bounces.
await day(14, 10, async () => {
  const cheques = await api<{ id: string; kind: string }[]>(owner, 'GET', '/treasury/cheques');
  for (const [i, ch] of cheques.entries()) {
    if (i % 3 === 2) continue; // still waiting
    await attempt('cheque', () => api(owner, 'PATCH', `/treasury/cheques/${ch.id}`, { kind: ch.kind, status: i === 0 ? 'BOUNCED' : 'CLEARED' }));
  }
});

// Treasury entries (expense, owner withdrawal, bank deposit) and one cancelled.
await day(12, 17, async () => {
  await api(owner, 'POST', '/treasury/entries', { type: 'EXPENSE', amount: 4500, category: 'إيجار', notes: 'إيجار مخزن المنصورة' });
  await api(owner, 'POST', '/treasury/entries', { type: 'EXPENSE', amount: 1800, category: 'كهرباء', paymentMethod: 'CASH' });
  await attempt('withdrawal', () => api(owner, 'POST', '/treasury/entries', { type: 'WITHDRAWAL', amount: 10000, notes: 'سحب شخصي' }));
  await attempt('bank deposit', () => api(owner, 'POST', '/treasury/entries', { type: 'BANK_DEPOSIT', amount: 20000, paymentMethod: 'CASH', notes: 'إيداع في البنك الأهلي' }));
  const e = await api(owner, 'POST', '/treasury/entries', { type: 'EXPENSE', amount: 999, category: 'نثريات' });
  await api(owner, 'PATCH', `/treasury/entries/${e.id}/cancel`, { reason: 'اتسجل مرتين' });
});

// From 30/9 purchases leave the treasury: supplier payments (cash, transfer, cheque), one cancelled,
// and new receipts paid in full, in part, and on credit.
await day(1, 11, async () => {
  for (const [i, s] of suppliers.entries()) {
    const detail = await api(owner, 'GET', `/suppliers/${s.id}`);
    const debt = detail.debt ?? 0;
    const amount = Math.min(debt, [30_000, 15_000, 10_000, 12_000, 3_000, 20_000][i]!);
    if (amount <= 0) continue;
    const method = ['CASH', 'BANK_TRANSFER', 'CHEQUE', 'CASH', 'VODAFONE_CASH', 'CASH'][i]!;
    const pay = await attempt(`supplier payment ${s.name}`, () => api(owner, 'POST', `/suppliers/${s.id}/payments`, { amount, ...payment(method), notes: 'دفعة من الحساب' }));
    if (i === 3 && pay) await api(owner, 'POST', `/suppliers/payments/${pay.id}/cancel`, { reason: 'الدفعة اترجعت' });
  }
  await receive(0, 1, [[1, 100, 98], [15, 40, 165]], 'all', 'توريد مدفوع كاش');
  await receive(2, 0, [[0, 120, 64], [13, 80, 60]], 5000, 'دفعنا جزء والباقي آجل');
  await receive(3, 4, [[5, 60, 57], [9, 30, 365]], 0, 'آجل 60 يوم');
});

// Today: a few sales, visits planned for tomorrow, and custody still with the reps.
await day(0, 0, async () => {
  for (const rep of sample(reps, 6)) await repDay(rep, true);
  for (const rep of sample(reps, 8)) {
    await attempt(`planned visit ${rep.username}`, () =>
      api(rep.s!, 'POST', '/visits', { customerId: pick(regionCustomers(rep.region)).id, purpose: pick(['SALE', 'COLLECTION', 'FOLLOW_UP']), scheduledAt: new Date(Date.now() + DAY).toISOString() }),
    );
  }
});

// Summaries hold dates (last invoice / collection), so recompute them after the shifts.
for (const c of await CustomerModel.find().select('_id')) await syncCustomerSummary(c._id);

console.log(`\nDone: ${log.ok} API calls.`);
console.log(`Refused by the API (expected business rules): ${log.skipped.length}`);
for (const s of log.skipped.slice(0, 40)) console.log('  -', s);
console.log(`\nLogins (password ${PASSWORD}): admin, store01..store05, rep, rep02..rep20. Owner: ${SEED_OWNER_USERNAME}`);
await mongoose.disconnect();
