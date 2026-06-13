import './register-mcp-paths';
import 'express-async-errors';
import dotenv from 'dotenv';
dotenv.config();

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
import agentRoutes from './agents/agent.router';

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
      RESEND_API_KEY: !!process.env.RESEND_API_KEY,
      AI_SERVICE_URL:  process.env.AI_SERVICE_URL || false,
      FRONTEND_ORIGIN: process.env.FRONTEND_ORIGIN || false,
      NODE_ENV:        process.env.NODE_ENV,
    },
  });
});

app.get('/api/v1/ping', (_req, res) => res.json({ pong: true }));

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/applications', applicationRoutes);
app.use('/api/v1/documents', documentRoutes);
app.use('/api/v1/review', reviewRoutes);
app.use('/api/v1/audit', auditRoutes);
app.use('/api/v1', agentRoutes);

app.get('/api/v1/debug/routes', (req, res) => {
  type RouteEntry = { method: string; path: string };
  const routes: RouteEntry[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function walk(stack: any[], prefix = '') {
    for (const layer of stack) {
      if (layer.route) {
        const methods = Object.keys(layer.route.methods).map(m => m.toUpperCase());
        for (const method of methods) {
          routes.push({ method, path: prefix + layer.route.path });
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        const sub = layer.regexp?.source
          ?.replace(/\\\//g, '/')
          .replace(/\^\\\//, '')
          .replace(/\\\/\?\(\?=\\\/\|\$\)/, '')
          .replace(/\(\?:\(\[\^\\\/\]\+\?\)\)/g, ':param')
          ?? '';
        walk(layer.handle.stack, prefix + '/' + sub.replace(/^\//, ''));
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  walk((app as any)._router.stack);
  res.json(routes);
});

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
    if (!process.env.SMTP_HOST)
      missing.push('SMTP_HOST');
    if (!process.env.SMTP_USER)
      missing.push('SMTP_USER');
    if (!process.env.SMTP_PASS)
      missing.push('SMTP_PASS');
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
