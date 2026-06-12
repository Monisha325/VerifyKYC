import { PrismaClient } from '@prisma/client';

// DIRECT_URL is required by the Prisma schema for migrations but not for
// runtime queries.  If it is not set on the host, fall back to DATABASE_URL
// so the application can start and serve requests without crashing.
if (!process.env.DIRECT_URL && process.env.DATABASE_URL) {
  process.env.DIRECT_URL = process.env.DATABASE_URL;
  console.warn('[PRISMA] DIRECT_URL not set — falling back to DATABASE_URL for runtime queries.');
}

// Append pool params to prevent Neon idle-connection drops.
// connection_limit=3 keeps the pool small for serverless; pool_timeout=30
// gives Prisma 30 s to acquire a connection before failing.
if (process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('connection_limit')) {
  const sep = process.env.DATABASE_URL.includes('?') ? '&' : '?';
  process.env.DATABASE_URL += `${sep}connection_limit=3&pool_timeout=30`;
}

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ log: ['error'] });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

// Eagerly establish the connection so the first pipeline write does not pay
// a cold-start round-trip to Neon.  Once connected, ping every 4 minutes to
// prevent Neon from suspending the compute and forcing a 2-5 s wake-up delay.
prisma.$connect()
  .then(() => {
    setInterval(async () => {
      try {
        await prisma.$queryRaw`SELECT 1`;
      } catch (err: unknown) {
        console.error('[prisma] keepalive ping failed:', err);
      }
    }, 240_000);
  })
  .catch((err: unknown) => {
    console.error('[prisma] initial $connect failed:', err);
  });

// ── withRetry ─────────────────────────────────────────────────────────────────
// Retries a Prisma operation up to `retries` times when the error looks like a
// dropped/closed connection (Neon serverless closes idle TCP connections).
// Non-connection errors (unique-constraint, not-found, validation) are rethrown
// immediately without consuming retry attempts.

export async function withRetry<T>(
  operation: () => Promise<T>,
  retries = 3,
  delayMs = 1000,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await operation();
    } catch (err: unknown) {
      lastErr = err;
      const msg = err instanceof Error ? err.message.toLowerCase() : '';
      const isConnectionErr =
        msg.includes('closed') ||
        msg.includes('connection') ||
        msg.includes('econnreset') ||
        msg.includes('econnrefused') ||
        msg.includes('pool_timeout') ||
        msg.includes('p1001') ||
        msg.includes('p1002');
      if (!isConnectionErr || attempt === retries) throw err;
      console.warn(
        `[prisma] connection error on attempt ${attempt}/${retries}, retrying in ${delayMs}ms — ${msg}`,
      );
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}
