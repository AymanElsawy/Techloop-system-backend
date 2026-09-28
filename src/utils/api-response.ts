import type { Response } from 'express';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export function ok(res: Response, data: unknown, status = 200) {
  res.status(status).json({ success: true, data });
}
