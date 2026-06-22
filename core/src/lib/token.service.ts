import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { Role } from '@prisma/client';

const ACCESS_SECRET = process.env.ACCESS_SECRET!;
const REFRESH_EXPIRY_DAYS = 7;

export interface AccessTokenPayload {
  sub: string;
  role: Role;
  iat?: number;
  exp?: number;
}

export function signAccessToken(payload: Omit<AccessTokenPayload, 'iat' | 'exp'>): string {
  return jwt.sign(payload, ACCESS_SECRET, { expiresIn: '15m' });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, ACCESS_SECRET) as AccessTokenPayload;
}

export function generateRawRefreshToken(): string {
  return crypto.randomBytes(64).toString('hex');
}

export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function refreshTokenExpiry(): Date {
  const d = new Date();
  d.setDate(d.getDate() + REFRESH_EXPIRY_DAYS);
  return d;
}

// ── Password reset — stateless, no DB storage ─────────────────────────────────
// A signed JWT scoped with purpose: 'password_reset' so it can never be
// accepted where an access token is expected (verifyAccessToken doesn't check
// purpose, but reset flows call verifyPasswordResetToken specifically, which
// rejects anything without this exact purpose claim).

interface PasswordResetTokenPayload {
  sub:     string;
  purpose: 'password_reset';
}

export function signPasswordResetToken(userId: string): string {
  const payload: PasswordResetTokenPayload = { sub: userId, purpose: 'password_reset' };
  return jwt.sign(payload, ACCESS_SECRET, { expiresIn: '30m' });
}

export function verifyPasswordResetToken(token: string): { sub: string } {
  const payload = jwt.verify(token, ACCESS_SECRET) as Partial<PasswordResetTokenPayload>;
  if (payload.purpose !== 'password_reset' || !payload.sub) {
    throw new Error('Invalid password reset token');
  }
  return { sub: payload.sub };
}
