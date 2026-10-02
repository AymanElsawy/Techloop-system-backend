import { z } from 'zod';
import { PaymentMethod } from '../invoices/invoice.types.js';

export const createSupplierPaymentSchema = z.object({
  amount: z.number().positive(),
  paymentMethod: z.enum(PaymentMethod),
  chequeNumber: z.string().trim().max(40).nullish(),
  chequeDueDate: z.iso.date().nullish(),
  notes: z.string().trim().max(1000).nullish(),
});

export const cancelSupplierPaymentSchema = z.object({
  reason: z.string().trim().min(1).max(300),
});

export type CreateSupplierPaymentInput = z.infer<typeof createSupplierPaymentSchema>;
