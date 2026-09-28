import type { Request } from 'express';
import { AppError } from '../utils/api-response.js';

export function notFound(req: Request) {
  throw new AppError(404, `Route not found: ${req.method} ${req.originalUrl}`);
}
