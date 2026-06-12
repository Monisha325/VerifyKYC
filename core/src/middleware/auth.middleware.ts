import { Request, Response, NextFunction } from 'express';
import { Role } from '@prisma/client';
import { verifyAccessToken } from '../lib/token.service';
import { AppError } from './errorHandler';

declare global {
  namespace Express {
    interface Request {
      user?: { sub: string; role: string };
    }
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new AppError(401, 'Authentication required');
  }
  try {
    req.user = verifyAccessToken(header.slice(7));
    next();
  } catch {
    throw new AppError(401, 'Invalid or expired access token');
  }
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) throw new AppError(401, 'Authentication required');
    if (!roles.includes(req.user.role as Role)) {
      throw new AppError(403, 'Insufficient permissions');
    }
    next();
  };
}
