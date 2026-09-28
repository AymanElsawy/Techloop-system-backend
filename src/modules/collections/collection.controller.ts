import path from 'node:path';
import type { Request, Response } from 'express';
import * as collectionService from './collection.service.js';
import { createCollectionSchema, listCollectionsSchema } from './collection.validation.js';
import {
  attachmentKindSchema,
  cancelInvoiceSchema as cancelSchema,
} from '../invoices/invoice.validation.js';
import { AppError, ok } from '../../utils/api-response.js';
import { createUpload } from '../../utils/upload.js';

type IdParams = { id: string };

export const collectionUpload = createUpload('collections');

export async function create(req: Request, res: Response) {
  ok(
    res,
    await collectionService.createCollection(createCollectionSchema.parse(req.body), req.user!),
    201,
  );
}

export async function list(req: Request, res: Response) {
  ok(
    res,
    await collectionService.listCollections(listCollectionsSchema.parse(req.query), req.user!),
  );
}

export async function getById(req: Request<IdParams>, res: Response) {
  ok(res, await collectionService.getCollectionById(req.params.id, req.user!));
}

export async function cancel(req: Request<IdParams>, res: Response) {
  const { reason } = cancelSchema.parse(req.body);
  ok(res, await collectionService.cancelCollection(req.params.id, reason, req.user!));
}

export async function uploadAttachment(req: Request<IdParams>, res: Response) {
  if (!req.file) throw new AppError(400, 'File is required');
  const { kind } = attachmentKindSchema.parse(req.body);
  ok(res, await collectionService.addAttachment(req.params.id, kind, req.file, req.user!), 201);
}

export async function downloadAttachment(
  req: Request<IdParams & { attachmentId: string }>,
  res: Response,
) {
  const attachment = await collectionService.getAttachment(
    req.params.id,
    req.params.attachmentId,
    req.user!,
  );
  res.type(attachment.mimeType);
  res.setHeader(
    'Content-Disposition',
    `inline; filename*=UTF-8''${encodeURIComponent(attachment.originalName)}`,
  );
  res.sendFile(path.join(collectionUpload.dir, attachment.fileName));
}
