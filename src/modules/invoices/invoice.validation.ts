import { z } from 'zod';
import { AttachmentKind, PaymentMethod } from './invoice.types.js';

const objectId = z.string().regex(/^[0-9a-f]{24}$/i, 'Invalid id');

export const createInvoiceSchema = z
  .object({
    invoiceNumber: z.string().trim().min(1).max(40),
    customerId: objectId,
    visitId: objectId.nullish(),
    warehouseId: objectId.nullish(), // managers only; reps always sell from their own warehouse
    items: z
      .array(z.object({ productId: objectId, quantity: z.number().int().positive() }))
      .min(1)
      .refine(
        (items) => new Set(items.map((i) => i.productId)).size === items.length,
        'Duplicate product',
      ),
    paidAmount: z.number().nonnegative().default(0),
    paymentMethod: z.enum(PaymentMethod).nullish(),
    chequeNumber: z.string().trim().max(40).nullish(),
    chequeDueDate: z.iso.date().nullish(),
    notes: z.string().trim().max(1000).nullish(),
  })
  .refine((v) => v.paidAmount === 0 || v.paymentMethod, {
    path: ['paymentMethod'],
    message: 'Payment method is required when an amount is paid',
  });

export const listInvoicesSchema = z.object({
  customerId: objectId.optional(),
  visitId: objectId.optional(),
});

export const cancelInvoiceSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

export const attachmentKindSchema = z.object({ kind: z.enum(AttachmentKind) });

export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;
export type ListInvoicesFilters = z.infer<typeof listInvoicesSchema>;
