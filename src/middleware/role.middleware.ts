import type { NextFunction, Request, Response } from 'express';
import type { UserRole } from '../modules/users/user.types.js';
import { AppError } from '../utils/api-response.js';

// Must run after authenticate. Role is read from the DB user, not the token.
export const authorize =
  (...roles: UserRole[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) throw new AppError(403, 'Forbidden');
    next();
  };
