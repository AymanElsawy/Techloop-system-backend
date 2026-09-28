import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../config/env.js';
import type { UserRole } from '../modules/users/user.types.js';

export interface AccessTokenPayload {
  userId: string;
  role: UserRole;
}

export function signAccessToken({ userId, role }: AccessTokenPayload) {
  return jwt.sign({ role }, env.JWT_SECRET, {
    subject: userId,
    expiresIn: env.JWT_EXPIRES_IN as SignOptions['expiresIn'],
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const payload = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as jwt.JwtPayload;
  return { userId: payload.sub!, role: payload.role };
}
