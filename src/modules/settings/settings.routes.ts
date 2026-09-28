import { Router } from 'express';
import { Schema, model } from 'mongoose';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth.middleware.js';
import { authorize } from '../../middleware/role.middleware.js';
import { ok } from '../../utils/api-response.js';
import { UserRole } from '../users/user.types.js';

/** Company details printed on every document. One document, key 'company'. */
const CompanyModel = model(
  'CompanySettings',
  new Schema(
    {
      key: { type: String, default: 'company', unique: true },
      name: { type: String, default: 'اسم الشركة' },
      phone: { type: String, default: null },
      address: { type: String, default: null },
      taxNumber: { type: String, default: null }, // الرقم الضريبي
      commercialRegister: { type: String, default: null }, // السجل التجاري
      footer: { type: String, default: null }, // printed at the bottom of every document
    },
    {
      timestamps: true,
      toJSON: {
        transform: (_doc, ret: Record<string, unknown>) => {
          delete ret._id;
          delete ret.__v;
          delete ret.key;
          return ret;
        },
      },
    },
  ),
);

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v === '' ? null : v));

const companySchema = z.object({
  name: z.string().trim().min(2).max(150),
  phone: text(60),
  address: text(300),
  taxNumber: text(50),
  commercialRegister: text(50),
  footer: text(500),
});

const getCompany = () =>
  CompanyModel.findOneAndUpdate({ key: 'company' }, {}, { upsert: true, returnDocument: 'after' });

export const settingsRoutes = Router();

settingsRoutes.use(authenticate);

settingsRoutes.get('/company', async (_req, res) => {
  ok(res, await getCompany());
});

settingsRoutes.put('/company', authorize(UserRole.OWNER, UserRole.ADMIN), async (req, res) => {
  const input = companySchema.parse(req.body);
  ok(
    res,
    await CompanyModel.findOneAndUpdate({ key: 'company' }, input, {
      upsert: true,
      returnDocument: 'after',
    }),
  );
});
