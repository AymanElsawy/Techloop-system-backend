import type { Response } from 'express';
import { Query } from 'mongoose';
import { z } from 'zod';
import { ok } from './api-response.js';

/** `?page=` turns paging on; without it the list comes back whole (pickers, offline cache). */
const pageSchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** One page of rows computed in memory; null when `?page=` isn't set. */
export function slicePage<T>(all: T[], query: unknown) {
  const { page, limit } = pageSchema.parse(query);
  if (!page) return null;
  const skip = (page - 1) * limit;
  return { items: all.slice(skip, skip + limit), meta: { page, limit, total: all.length } };
}

/**
 * Sends a list, one page of it when `?page=` is set: `{ data: [...], meta: { page, limit, total } }`.
 * A Mongoose query is paged in the DB; an array (rows computed in memory) is sliced.
 */
export async function sendList<T>(
  res: Response,
  query: unknown,
  list: PromiseLike<T[]>,
  extra?: (all: T[]) => Record<string, unknown>,
) {
  const { page, limit } = pageSchema.parse(query);
  if (!page) return ok(res, await list);
  const skip = (page - 1) * limit;
  if (list instanceof Query) {
    const q = list as Query<T[], unknown>;
    const [items, total] = await Promise.all([
      q.clone().sort({ _id: 1 }).skip(skip).limit(limit), // _id: tie-breaker, so pages don't overlap
      q.model.countDocuments(q.getFilter()),
    ]);
    return ok(res, items, 200, { page, limit, total });
  }
  const all = await list;
  const { items, meta } = slicePage(all, query)!;
  ok(res, items, 200, { ...meta, ...extra?.(all) });
}
