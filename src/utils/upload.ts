import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { env } from '../config/env.js';
import { AppError } from './api-response.js';

const ALLOWED_TYPES: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
};

/**
 * Single-file upload (field `file`) stored under UPLOAD_DIR/<subdir> with a random name.
 * Files are only served back through authenticated routes.
 */
export function createUpload(subdir: string) {
  const dir = path.resolve(env.UPLOAD_DIR, subdir);
  mkdirSync(dir, { recursive: true });

  const upload = multer({
    storage: multer.diskStorage({
      destination: dir,
      filename: (_req, file, cb) => cb(null, randomUUID() + ALLOWED_TYPES[file.mimetype]),
    }),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, cb) =>
      file.mimetype in ALLOWED_TYPES
        ? cb(null, true)
        : cb(new AppError(400, 'Only JPG, PNG, WEBP or PDF files are allowed')),
  });

  return { dir, single: upload.single('file') };
}
