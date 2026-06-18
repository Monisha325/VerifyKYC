import { Router }      from 'express';
import rateLimit       from 'express-rate-limit';
import { RedisStore }  from 'rate-limit-redis';
import IORedis         from 'ioredis';
import { register, login, verifyEmail, resendOtp, refresh, logout, me } from './auth.controller';
import { requireAuth } from '../../middleware/auth.middleware';

// ── Redis store (Upstash in production; falls back to in-memory in dev) ───────
// Upstash provides both an HTTP REST URL (for @upstash/redis) and a Redis URL
// (rediss://...) for standard clients like ioredis. rate-limit-redis requires
// the ioredis-style sendCommand API, so we connect via UPSTASH_REDIS_URL.
// The underlying connection can be shared, but express-rate-limit requires a
// distinct RedisStore *instance* (unique prefix) per limiter.
const redisClient = process.env.UPSTASH_REDIS_URL
  ? new IORedis(process.env.UPSTASH_REDIS_URL, { tls: {} })
  : undefined;

function makeRedisStore(prefix: string) {
  if (!redisClient) return undefined;
  return new RedisStore({
    sendCommand: (...args: string[]) => redisClient.call(args[0], ...args.slice(1)) as Promise<number>,
    prefix,
  });
}

// ── Rate limiters ─────────────────────────────────────────────────────────────

const credentialStore = makeRedisStore('rl:verikyc:credential:');
const refreshStore    = makeRedisStore('rl:verikyc:refresh:');
const resendStore     = makeRedisStore('rl:verikyc:resend:');

const credentialLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             10,
  standardHeaders: 'draft-7',
  legacyHeaders:   false,
  message:         { error: 'Too many attempts. Please try again in 15 minutes.' },
  skip:            () => process.env.NODE_ENV !== 'production',
  ...(credentialStore && { store: credentialStore }),
});

const refreshLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             30,
  standardHeaders: 'draft-7',
  legacyHeaders:   false,
  message:         { error: 'Too many refresh requests. Please try again later.' },
  ...(refreshStore && { store: refreshStore }),
});

// Max 3 resend OTP attempts per 10 min, keyed on email address
const resendLimiter = rateLimit({
  windowMs:        10 * 60 * 1000,
  max:             3,
  standardHeaders: 'draft-7',
  legacyHeaders:   false,
  message:         { error: 'Too many resend attempts. Please wait 10 minutes.' },
  keyGenerator:    (req) => String(req.body?.email ?? 'anonymous'),
  skip:            () => process.env.NODE_ENV !== 'production',
  ...(resendStore && { store: resendStore }),
});

const router = Router();

router.post('/register',     credentialLimiter, register);
router.post('/login',        credentialLimiter, login);
router.post('/verify-email', verifyEmail);
router.post('/resend-otp',   resendLimiter,     resendOtp);
router.post('/refresh',      refreshLimiter,    refresh);
router.post('/logout',       logout);
router.get('/me',            requireAuth,       me);

export default router;
