import type { NextFunction, Request, Response } from 'express';
import { UserModel, type UserDocument } from '../modules/users/user.model.js';
import { verifyAccessToken } from '../utils/jwt.js';
import { AppError } from '../utils/api-response.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserDocument;
    }
  }
}

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const [scheme, token] = req.headers.authorization?.split(' ') ?? [];
  if (scheme !== 'Bearer' || !token) throw new AppError(401, 'Authentication required');

  const { userId } = verifyAccessToken(token);
  const user = await UserModel.findById(userId);
  if (!user || !user.isActive) throw new AppError(401, 'Authentication required');

  req.user = user;
  next();
}
