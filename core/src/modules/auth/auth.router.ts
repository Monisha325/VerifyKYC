import { Router }    from 'express';
import rateLimit     from 'express-rate-limit';
import { register, login, verifyEmail, resendOtp, refresh, logout, me } from './auth.controller';
import { requireAuth } from '../../middleware/auth.middleware';

// ── Rate limiters ─────────────────────────────────────────────────────────────

const credentialLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             10,
  standardHeaders: 'draft-7',
  legacyHeaders:   false,
  message:         { error: 'Too many attempts. Please try again in 15 minutes.' },
  skip:            () => process.env.NODE_ENV !== 'production',
});

const refreshLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             30,
  standardHeaders: 'draft-7',
  legacyHeaders:   false,
  message:         { error: 'Too many refresh requests. Please try again later.' },
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
