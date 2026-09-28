import path from 'node:path';
import type { Request, Response } from 'express';
import * as invoiceService from './invoice.service.js';
import { createUpload } from '../../utils/upload.js';
import {
  attachmentKindSchema,
  cancelInvoiceSchema,
  createInvoiceSchema,
  listInvoicesSchema,
} from './invoice.validation.js';
import { AppError, ok } from '../../utils/api-response.js';

type IdParams = { id: string };

export const invoiceUpload = createUpload('invoices');

export async function create(req: Request, res: Response) {
  ok(res, await invoiceService.createInvoice(createInvoiceSchema.parse(req.body), req.user!), 201);
}

export async function list(req: Request, res: Response) {
  ok(res, await invoiceService.listInvoices(listInvoicesSchema.parse(req.query), req.user!));
}

export async function getById(req: Request<IdParams>, res: Response) {
  ok(res, await invoiceService.getInvoiceById(req.params.id, req.user!));
}

export async function cancel(req: Request<IdParams>, res: Response) {
  const { reason } = cancelInvoiceSchema.parse(req.body);
  ok(res, await invoiceService.cancelInvoice(req.params.id, reason, req.user!));
}

export async function uploadAttachment(req: Request<IdParams>, res: Response) {
  if (!req.file) throw new AppError(400, 'File is required');
  const { kind } = attachmentKindSchema.parse(req.body);
  ok(res, await invoiceService.addAttachment(req.params.id, kind, req.file, req.user!), 201);
}

export async function downloadAttachment(
  req: Request<IdParams & { attachmentId: string }>,
  res: Response,
) {
  const attachment = await invoiceService.getAttachment(
    req.params.id,
    req.params.attachmentId,
    req.user!,
  );
  res.type(attachment.mimeType);
  res.setHeader(
    'Content-Disposition',
    `inline; filename*=UTF-8''${encodeURIComponent(attachment.originalName)}`,
  );
  res.sendFile(path.join(invoiceUpload.dir, attachment.fileName));
}
