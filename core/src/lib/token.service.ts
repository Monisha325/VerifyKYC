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
