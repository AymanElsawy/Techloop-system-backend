import { z } from 'zod';
import { VisitPurpose, VisitStatus } from './visit.types.js';

const objectId = z.string().regex(/^[0-9a-f]{24}$/i, 'Invalid id');

export const createVisitSchema = z.object({
  customerId: objectId,
  // Required for Owner/Admin; ignored for sales reps (always themselves).
  salesRepId: objectId.optional(),
  purpose: z.enum(VisitPurpose),
  scheduledAt: z.iso.datetime(),
});

export const listVisitsSchema = z.object({
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  status: z.enum(VisitStatus).optional(),
  customerId: objectId.optional(),
});

export const startVisitSchema = z.object({
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
});

export const completeVisitSchema = z.object({
  notes: z.string().trim().max(2000).nullish(),
  productsDiscussed: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
  customerFeedback: z.string().trim().max(2000).nullish(),
  nextVisitAt: z.iso.datetime().nullish(),
});

export const cancelVisitSchema = z.object({
  reason: z.string().trim().max(500).nullish(),
});

export type CreateVisitInput = z.infer<typeof createVisitSchema>;
export type ListVisitsFilters = z.infer<typeof listVisitsSchema>;
export type CompleteVisitInput = z.infer<typeof completeVisitSchema>;
