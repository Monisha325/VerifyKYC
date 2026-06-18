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

// Prisma codes for a lost/unreachable database connection (e.g. Neon auto-suspend
// closing an idle connection mid-query) — distinct from query-logic errors like
// unique-constraint violations, which stay 500.
const CONNECTION_ERROR_CODES = new Set([
  'P1001', // Can't reach database server
  'P1002', // Database server timed out
  'P1008', // Operation timed out
  'P1009', // Database already exists (rare here, but pool/init related)
  'P1010', // Access denied
  'P1011', // TLS connection error
  'P1017', // Server has closed the connection
]);

function isConnectionClosedMessage(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes('kind: closed') || m.includes('connection closed') || m.includes("server has closed the connection");
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
  // Prisma known errors (e.g. unique violation, table not found, or a dropped connection)
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    console.error(`[DB] PrismaClientKnownRequestError code=${err.code} message=${err.message}`);
    if (CONNECTION_ERROR_CODES.has(err.code)) {
      return res.status(503).json({ error: 'Database temporarily unavailable', code: err.code });
    }
    return res.status(500).json({ error: 'Database error', code: err.code });
  }
  // Prisma engine error with no known code (e.g. raw "connection closed" from the driver)
  if (err instanceof Prisma.PrismaClientUnknownRequestError) {
    console.error(`[DB] PrismaClientUnknownRequestError: ${err.message}`);
    if (isConnectionClosedMessage(err.message)) {
      return res.status(503).json({ error: 'Database temporarily unavailable' });
    }
    return res.status(500).json({ error: 'Database error' });
  }
  // Prisma initialization error (e.g. missing DATABASE_URL or DIRECT_URL, or can't connect)
  if (err instanceof Prisma.PrismaClientInitializationError) {
    console.error(`[DB] PrismaClientInitializationError: ${err.message}`);
    return res.status(503).json({ error: 'Database connection failed', detail: err.message.slice(0, 200) });
  }
  // Prisma validation error (e.g. schema mismatch)
  if (err instanceof Prisma.PrismaClientValidationError) {
    console.error(`[DB] PrismaClientValidationError: ${err.message}`);
    return res.status(500).json({ error: 'Database validation error' });
  }
  console.error('[UNHANDLED]', err);
  return res.status(500).json({ error: 'Internal server error', detail: (err as Error).message?.slice(0, 200) });
}
