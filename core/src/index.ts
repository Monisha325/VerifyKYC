import './register-mcp-paths';
import 'express-async-errors';
import dotenv from 'dotenv';
dotenv.config();

// Last-resort safety net: log the full error before the process dies, so a
// crash is traceable in Render's logs instead of showing up as a silent
// restart (e.g. an EventEmitter 'error' with no listener, or a rejected
// promise outside the Express request lifecycle).
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.stack ?? err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled promise rejection:', reason instanceof Error ? reason.stack : reason);
  process.exit(1);
});

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';

import { errorHandler } from './middleware/errorHandler';
import { prisma }       from './utils/prisma';
import authRoutes from './modules/auth/auth.router';
import applicationRoutes from './modules/applications/application.router';
import documentRoutes from './routes/document.routes';
import reviewRoutes from './routes/review.routes';
import auditRoutes from './routes/audit.routes';
import agentRoutes from './routes/agent.routes';

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 4000;

app.use(helmet());
app.use(cors({
  origin: function(origin, callback) {
    const allowed = process.env.FRONTEND_ORIGIN;
    if (
      !origin ||
      (allowed && origin === allowed) ||
      origin.endsWith('.vercel.app') ||
      origin === 'http://localhost:3000'
    ) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

app.get('/health', async (_req, res) => {
  let dbStatus = 'error';
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbStatus = 'ok';
  } catch (e: unknown) {
    dbStatus = (e as Error).message ?? 'error';
  }
  res.json({
    status:  'ok',
    service: 'verikyc-core',
    commit:  process.env.RENDER_GIT_COMMIT ?? 'unknown',
    db:      dbStatus,
    vars: {
      DATABASE_URL:  !!process.env.DATABASE_URL,
      ACCESS_SECRET: !!process.env.ACCESS_SECRET,
      REFRESH_SECRET: !!process.env.REFRESH_SECRET,
      BREVO_API_KEY: !!process.env.BREVO_API_KEY,
      AI_SERVICE_URL:  process.env.AI_SERVICE_URL || false,
      FRONTEND_ORIGIN: process.env.FRONTEND_ORIGIN || false,
      NODE_ENV:        process.env.NODE_ENV,
      GEMINI_API_KEY:  !!process.env.GEMINI_API_KEY,
      GEMINI_MODEL:    process.env.GEMINI_MODEL || false,
    },
  });
});

app.get('/api/v1/ping', (_req, res) => res.json({ pong: true }));

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/applications', applicationRoutes);
app.use('/api/v1/documents', documentRoutes);
app.use('/api/v1/review', reviewRoutes);
app.use('/api/v1/audit', auditRoutes);
// MCP agents (auth/kyc/members) + /agent/chat orchestrator
// Accepts both MCP Streamable HTTP and REST — mounted last so it
// doesn't shadow existing /api/v1/* routes.
// Note: MCP endpoints require Accept: application/json, text/event-stream header.
app.use('/api/v1', agentRoutes);

app.use(errorHandler);

const server = app.listen(PORT, () => {
  console.log(`VeriKYC Core API running on http://localhost:${PORT}`);

  // ── Production config sanity-check ────────────────────────────────────────
  // Logs warnings that are visible in Render's log stream immediately on boot.
  if (process.env.NODE_ENV === 'production') {
    const missing: string[] = [];

    if (!process.env.AI_SERVICE_URL || process.env.AI_SERVICE_URL.includes('localhost'))
      missing.push('AI_SERVICE_URL (still points to localhost — set to Railway URL)');
    if (!process.env.INTERNAL_TOKEN)
      missing.push('INTERNAL_TOKEN');
    if (!process.env.BREVO_API_KEY)
      missing.push('BREVO_API_KEY');
    if (!process.env.FRONTEND_ORIGIN || process.env.FRONTEND_ORIGIN.includes('localhost'))
      missing.push('FRONTEND_ORIGIN (still points to localhost — set to Vercel URL)');

    if (missing.length > 0) {
      console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.error('⚠️  MISSING / INVALID PRODUCTION ENV VARS:');
      missing.forEach(v => console.error(`   ✗  ${v}`));
      console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    } else {
      console.log('✅ All required production env vars present.');
    }
  }
});
server.timeout = 120_000;  // 2 min — allows large selfie batches to complete

export default app;
