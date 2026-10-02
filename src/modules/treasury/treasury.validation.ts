import { z } from 'zod';
import { ChequeStatus, TreasuryEntryType } from './treasury.types.js';
import { PaymentMethod } from '../invoices/invoice.types.js';

const objectId = z.string().regex(/^[0-9a-f]{24}$/i, 'Invalid id');
const ids = z
  .array(objectId)
  .max(500)
  .default([])
  .transform((list) => [...new Set(list)]);

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => v || null);

export const createDepositSchema = z
  .object({
    repId: objectId,
    invoiceIds: ids,
    collectionIds: ids,
    expenseIds: ids, // the rep's pending expenses the manager accepts
    notes: optionalText(500),
  })
  .refine((v) => v.invoiceIds.length + v.collectionIds.length > 0, {
    message: 'Select at least one payment',
  });

export const repFilterSchema = z.object({ repId: objectId.optional() });

export const createEntrySchema = z
  .object({
    type: z.enum(TreasuryEntryType),
    amount: z.number().positive(),
    paymentMethod: z.enum(PaymentMethod).default(PaymentMethod.CASH),
    category: optionalText(60),
    notes: optionalText(500),
  })
  .refine(
    (v) =>
      v.type !== TreasuryEntryType.BANK_DEPOSIT || v.paymentMethod !== PaymentMethod.BANK_TRANSFER,
    { path: ['paymentMethod'], message: 'Money in the bank cannot be deposited again' },
  );

export const listEntriesSchema = z.object({
  type: z.enum(TreasuryEntryType).optional(),
  repId: objectId.optional(),
  pending: z.stringbool().optional(), // rep expenses not handed over yet
});

/** A rep's expense from their cash box. */
export const createRepExpenseSchema = z.object({
  amount: z.number().positive(),
  category: optionalText(60),
  notes: optionalText(500),
});

export const cancelEntrySchema = z.object({ reason: z.string().trim().min(3).max(500) });

export const chequeStatusSchema = z.object({
  kind: z.enum(['INVOICE', 'COLLECTION']),
  status: z.enum(ChequeStatus),
});

export type CreateRepExpenseInput = z.infer<typeof createRepExpenseSchema>;
export type ListEntriesFilters = z.infer<typeof listEntriesSchema>;
export type CreateEntryInput = z.infer<typeof createEntrySchema>;
export type CreateDepositInput = z.infer<typeof createDepositSchema>;
