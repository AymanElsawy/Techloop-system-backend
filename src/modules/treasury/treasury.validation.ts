import { z } from 'zod';

const objectId = z.string().regex(/^[0-9a-f]{24}$/i, 'Invalid id');
const ids = z
  .array(objectId)
  .max(500)
  .default([])
  .transform((list) => [...new Set(list)]);

export const createDepositSchema = z
  .object({
    repId: objectId,
    invoiceIds: ids,
    collectionIds: ids,
    notes: z
      .string()
      .trim()
      .max(500)
      .nullish()
      .transform((v) => v || null),
  })
  .refine((v) => v.invoiceIds.length + v.collectionIds.length > 0, {
    message: 'Select at least one payment',
  });

export const repFilterSchema = z.object({ repId: objectId.optional() });

export type CreateDepositInput = z.infer<typeof createDepositSchema>;
