import { z } from 'zod';
import { PaymentMethod } from '../invoices/invoice.types.js';

const objectId = z.string().regex(/^[0-9a-f]{24}$/i, 'Invalid id');

export const createCollectionSchema = z.object({
  receiptNumber: z.string().trim().min(1).max(40),
  customerId: objectId,
  visitId: objectId.nullish(),
  amount: z.number().positive(),
  paymentMethod: z.enum(PaymentMethod),
  chequeNumber: z.string().trim().max(40).nullish(),
  chequeDueDate: z.iso.date().nullish(),
  notes: z.string().trim().max(1000).nullish(),
});

export const listCollectionsSchema = z.object({
  customerId: objectId.optional(),
  visitId: objectId.optional(),
});

export type CreateCollectionInput = z.infer<typeof createCollectionSchema>;
export type ListCollectionsFilters = z.infer<typeof listCollectionsSchema>;
