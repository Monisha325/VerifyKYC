import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string,
    public meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof AppError) {
    const body: Record<string, unknown> = { error: err.message };
    if (err.code) body.code = err.code;
    if (err.meta) Object.assign(body, err.meta);
    return res.status(err.statusCode).json(body);
  }
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'Validation failed',
      details: err.flatten().fieldErrors,
    });
  }
  // Prisma known errors (e.g. unique violation, table not found)
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    console.error(`[DB] PrismaClientKnownRequestError code=${err.code} message=${err.message}`);
    return res.status(500).json({ error: 'Database error', code: err.code });
  }
  // Prisma initialization error (e.g. missing DATABASE_URL or DIRECT_URL)
  if (err instanceof Prisma.PrismaClientInitializationError) {
    console.error(`[DB] PrismaClientInitializationError: ${err.message}`);
    return res.status(500).json({ error: 'Database connection failed', detail: err.message.slice(0, 200) });
  }
  // Prisma validation error (e.g. schema mismatch)
  if (err instanceof Prisma.PrismaClientValidationError) {
    console.error(`[DB] PrismaClientValidationError: ${err.message}`);
    return res.status(500).json({ error: 'Database validation error' });
  }
  console.error('[UNHANDLED]', err);
  return res.status(500).json({ error: 'Internal server error', detail: (err as Error).message?.slice(0, 200) });
}
