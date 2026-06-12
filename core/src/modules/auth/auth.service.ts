import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import { prisma } from '../../utils/prisma';
import { audit }  from '../../utils/audit';
import { AppError } from '../../middleware/errorHandler';
import {
  signAccessToken,
  generateRawRefreshToken,
  hashToken,
  refreshTokenExpiry,
} from '../../lib/token.service';
import {
  generateOtp,
  sendOtpEmail,
  createOtpRecord,
  verifyOtp,
} from './otp.service';
import { RegisterDto, LoginDto, VerifyEmailDto, ResendOtpDto } from './auth.schema';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTokenSet(family?: string) {
  const raw = generateRawRefreshToken();
  const tokenFamily = family ?? generateRawRefreshToken().slice(0, 32);
  return { raw, hashed: hashToken(raw), expiresAt: refreshTokenExpiry(), family: tokenFamily };
}

function setRefreshCookie(
  res: import('express').Response,
  raw: string,
  expiresAt: Date,
) {
  const isProd = process.env.NODE_ENV === 'production';
  res.cookie('verikyc_rt', raw, {
    httpOnly: true,
    secure:   isProd,
    sameSite: 'strict',
    path:     '/api/v1/auth',
    expires:  expiresAt,
  });
}

// ─── Register ─────────────────────────────────────────────────────────────────
// Returns { message, email } — no JWT until email is verified.

export async function registerUser(
  dto: RegisterDto,
  ipAddress?: string,
): Promise<{ message: string; email: string; devOtp?: string }> {
  const existing = await prisma.user.findUnique({
    where: { email: dto.email.toLowerCase().trim() },
  });
  if (existing) throw new AppError(409, 'Email already registered');

  const passwordHash = await argon2Hash(dto.password);
  const user = await prisma.user.create({
    data: {
      email:         dto.email.toLowerCase().trim(),
      passwordHash,
      fullName:      dto.fullName.trim(),
      phone:         dto.phone,
      emailVerified: false,
    },
    select: { id: true, email: true, fullName: true, role: true, createdAt: true },
  });

  await audit({ action: 'USER_REGISTERED', entity: 'User', entityId: user.id, actorId: user.id, ipAddress });

  const otp = generateOtp();
  await createOtpRecord(user.id, otp);
  // Fire-and-forget — OTP is in DB; email is best-effort. Never blocks the response.
  sendOtpEmail(user.email, otp).catch(e => console.error('[OTP] Background send failed:', e));

  return {
    message: 'Verification code sent to your email',
    email:   user.email,
  };
}

// ─── Login ────────────────────────────────────────────────────────────────────

export async function loginUser(
  dto: LoginDto,
  res: import('express').Response,
  ipAddress?: string,
) {
  const user = await prisma.user.findUnique({
    where: { email: dto.email.toLowerCase().trim() },
  });
  const dummyHash =
    '$argon2id$v=19$m=65536,t=3,p=4$dummysaltdummysalt$dummyhashvaluedummyhashvalue';
  const valid = user
    ? await argon2Verify(user.passwordHash, dto.password)
    : (await argon2Verify(dummyHash, dto.password).catch(() => false), false);

  if (!user || !valid) throw new AppError(401, 'Invalid email or password');

  if (!user.emailVerified) {
    throw new AppError(403, 'Email not verified', 'EMAIL_NOT_VERIFIED');
  }

  const { raw, hashed, expiresAt, family } = makeTokenSet();
  await prisma.refreshToken.create({
    data: { token: hashed, userId: user.id, expiresAt, family },
  });

  await audit({ action: 'USER_LOGIN', entity: 'User', entityId: user.id, actorId: user.id, ipAddress });

  const accessToken = signAccessToken({ sub: user.id, role: user.role });
  setRefreshCookie(res, raw, expiresAt);

  const { passwordHash: _pw, ...safeUser } = user;
  return { user: safeUser, accessToken };
}

// ─── Verify email ─────────────────────────────────────────────────────────────

export async function verifyEmail(
  dto: VerifyEmailDto,
  res: import('express').Response,
  ipAddress?: string,
) {
  const user = await prisma.user.findUnique({
    where:  { email: dto.email.toLowerCase().trim() },
    select: { id: true, email: true, fullName: true, role: true, emailVerified: true, isVerified: true, createdAt: true, updatedAt: true },
  });
  if (!user) throw new AppError(401, 'Invalid or expired OTP');

  await verifyOtp(user.id, dto.otp);

  const { raw, hashed, expiresAt, family } = makeTokenSet();
  await prisma.refreshToken.create({
    data: { token: hashed, userId: user.id, expiresAt, family },
  });

  await audit({ action: 'EMAIL_VERIFIED', entity: 'User', entityId: user.id, actorId: user.id, ipAddress });

  const accessToken = signAccessToken({ sub: user.id, role: user.role });
  setRefreshCookie(res, raw, expiresAt);

  return { user: { id: user.id, email: user.email, fullName: user.fullName, role: user.role }, accessToken };
}

// ─── Resend OTP ───────────────────────────────────────────────────────────────

export async function resendOtp(dto: ResendOtpDto): Promise<{ message: string; devOtp?: string }> {
  const user = await prisma.user.findUnique({
    where:  { email: dto.email.toLowerCase().trim() },
    select: { id: true, email: true, emailVerified: true },
  });
  if (!user) {
    return { message: 'If this email exists, a new code has been sent.' };
  }
  if (user.emailVerified) throw new AppError(409, 'Email already verified');

  const otp = generateOtp();
  await createOtpRecord(user.id, otp);
  sendOtpEmail(user.email, otp).catch(e => console.error('[OTP] Background send failed:', e));

  return { message: 'Verification code resent to your email' };
}

// ─── Refresh ──────────────────────────────────────────────────────────────────

export async function rotateRefreshToken(
  rawToken: string,
  res: import('express').Response,
  ipAddress?: string,
) {
  const hashed = hashToken(rawToken);
  const stored = await prisma.refreshToken.findUnique({ where: { token: hashed } });

  if (!stored) throw new AppError(401, 'Invalid refresh token');

  if (stored.revokedAt) {
    const revokeWhere = stored.family
      ? { family: stored.family }
      : { userId: stored.userId };
    await prisma.refreshToken.updateMany({
      where: revokeWhere,
      data:  { revokedAt: new Date() },
    });
    await audit({
      action:   'TOKEN_THEFT_DETECTED',
      entity:   'RefreshToken',
      entityId: stored.id,
      actorId:  stored.userId,
      ipAddress,
      meta:     { family: stored.family || null },
    });
    throw new AppError(401, 'Token reuse detected — all sessions in this family have been revoked');
  }

  if (stored.expiresAt < new Date()) throw new AppError(401, 'Refresh token expired');

  await prisma.refreshToken.update({
    where: { id: stored.id },
    data:  { rotatedAt: new Date(), revokedAt: new Date() },
  });

  const user = await prisma.user.findUniqueOrThrow({
    where:  { id: stored.userId },
    select: { id: true, role: true },
  });

  const { raw, hashed: newHashed, expiresAt } = makeTokenSet(stored.family || undefined);
  await prisma.refreshToken.create({
    data: { token: newHashed, userId: user.id, expiresAt, family: stored.family || '' },
  });

  await audit({
    action:   'TOKEN_ROTATED',
    entity:   'RefreshToken',
    entityId: stored.id,
    actorId:  user.id,
    ipAddress,
  });

  const accessToken = signAccessToken({ sub: user.id, role: user.role });
  setRefreshCookie(res, raw, expiresAt);
  return { accessToken };
}

// ─── Logout ───────────────────────────────────────────────────────────────────

export async function logoutUser(
  rawToken: string | undefined,
  actorId: string | undefined,
  res: import('express').Response,
  ipAddress?: string,
) {
  if (rawToken) {
    const hashed = hashToken(rawToken);
    const stored = await prisma.refreshToken.findUnique({ where: { token: hashed } });
    if (stored && !stored.revokedAt) {
      await prisma.refreshToken.update({
        where: { id: stored.id },
        data:  { revokedAt: new Date() },
      });
    }
  }

  await audit({ action: 'USER_LOGOUT', entity: 'User', actorId, ipAddress });

  const isProd = process.env.NODE_ENV === 'production';
  res.clearCookie('verikyc_rt', {
    httpOnly: true,
    secure:   isProd,
    sameSite: 'strict',
    path:     '/api/v1/auth',
  });
}
