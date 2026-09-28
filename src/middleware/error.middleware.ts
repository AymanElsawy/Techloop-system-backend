import type { NextFunction, Request, Response } from 'express';
import { ZodError, z } from 'zod';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import { AppError } from '../utils/api-response.js';
import { env } from '../config/env.js';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: z.flattenError(err).fieldErrors,
    });
    return;
  }

  let status = 500;
  let message = 'Internal server error';

  if (err instanceof AppError) {
    status = err.statusCode;
    message = err.message;
  } else if (err instanceof multer.MulterError) {
    status = 400;
    message = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (max 5 MB)' : err.message;
  } else if (err instanceof jwt.JsonWebTokenError) {
    status = 401;
    message = 'Invalid or expired token';
  } else if (err instanceof mongoose.Error.CastError) {
    status = 400;
    message = `Invalid ${err.path}`;
  } else if ((err as { code?: number }).code === 11000) {
    status = 409;
    const field = Object.keys((err as { keyValue?: object }).keyValue ?? {})[0];
    message = field ? `${field} already in use` : 'Already exists';
  } else if ((err as { type?: string }).type === 'entity.parse.failed') {
    status = 400;
    message = 'Malformed JSON body';
  }

  if (status === 500) console.error(err);

  res.status(status).json({
    success: false,
    message,
    ...(status === 500 && env.NODE_ENV === 'development' && { stack: (err as Error).stack }),
  });
}
