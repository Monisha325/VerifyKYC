import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import { prisma } from '../../utils/prisma';
import { audit }  from '../../utils/audit';
import { AppError } from '../../middleware/errorHandler';
import {
  signAccessToken,
  generateRawRefreshToken,
  hashToken,
  refreshTokenExpiry,
  signPasswordResetToken,
  verifyPasswordResetToken,
} from '../../lib/token.service';
import {
  generateOtp,
  sendOtpEmail,
  createOtpRecord,
  verifyOtp,
  sendPasswordResetEmail,
} from './otp.service';
import {
  RegisterDto, LoginDto, VerifyEmailDto, ResendOtpDto,
  ForgotPasswordDto, ResetPasswordDto, ChangePasswordDto, UpdateProfileDto,
} from './auth.schema';

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
  if (!user.isActive) {
    throw new AppError(403, 'This account has been disabled', 'ACCOUNT_DISABLED');
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

// ─── Forgot password ──────────────────────────────────────────────────────────
// Always returns the same generic message regardless of whether the email
// exists — same email-enumeration guard as resendOtp.

export async function forgotPassword(
  dto: ForgotPasswordDto,
): Promise<{ message: string }> {
  const user = await prisma.user.findUnique({
    where:  { email: dto.email.toLowerCase().trim() },
    select: { id: true, email: true },
  });

  if (user) {
    const resetToken = signPasswordResetToken(user.id);
    sendPasswordResetEmail(user.email, resetToken)
      .catch(e => console.error('[RESET] Background send failed:', e));
    await audit({ action: 'PASSWORD_RESET_REQUESTED', entity: 'User', entityId: user.id, actorId: user.id });
  }

  return { message: 'If this email exists, a password reset link has been sent.' };
}

// ─── Reset password (via emailed token) ──────────────────────────────────────
// Revokes every existing refresh token for the user — a password reset should
// end every other session, not just rotate the one in use.

export async function resetPassword(
  dto: ResetPasswordDto,
): Promise<{ message: string }> {
  // A valid JWT never legitimately contains whitespace — strip all of it
  // (not just leading/trailing) defensively, since the token is long enough
  // that users copy-paste it from an email, and some email clients turn the
  // email's CSS word-wrapping into real embedded newlines/spaces on copy.
  const cleanToken = dto.resetToken.replace(/\s+/g, '');

  let userId: string;
  try {
    userId = verifyPasswordResetToken(cleanToken).sub;
  } catch {
    throw new AppError(401, 'Invalid or expired reset token');
  }

  const passwordHash = await argon2Hash(dto.newPassword);
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { passwordHash } }),
    prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data:  { revokedAt: new Date() },
    }),
  ]);

  await audit({ action: 'PASSWORD_RESET', entity: 'User', entityId: userId, actorId: userId });

  return { message: 'Password reset successfully. Please log in again.' };
}

// ─── Change password (while logged in) ───────────────────────────────────────

export async function changePassword(
  userId: string,
  dto: ChangePasswordDto,
): Promise<{ message: string }> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  const valid = await argon2Verify(user.passwordHash, dto.currentPassword);
  if (!valid) throw new AppError(401, 'Current password is incorrect');

  const passwordHash = await argon2Hash(dto.newPassword);
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { passwordHash } }),
    prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data:  { revokedAt: new Date() },
    }),
  ]);

  await audit({ action: 'PASSWORD_CHANGED', entity: 'User', entityId: userId, actorId: userId });

  return { message: 'Password changed successfully. Please log in again.' };
}

// ─── Update profile ───────────────────────────────────────────────────────────

export async function updateProfile(userId: string, dto: UpdateProfileDto) {
  const user = await prisma.user.update({
    where: { id: userId },
    data:  {
      ...(dto.fullName !== undefined && { fullName: dto.fullName }),
      ...(dto.phone    !== undefined && { phone:    dto.phone }),
    },
    select: { id: true, email: true, fullName: true, phone: true, role: true, isVerified: true, emailVerified: true, createdAt: true, updatedAt: true },
  });

  await audit({ action: 'PROFILE_UPDATED', entity: 'User', entityId: userId, actorId: userId });

  return user;
}

// ─── Admin user management ────────────────────────────────────────────────────
// All four below are ADMIN-only actions — enforced by the agent dispatch layer
// (orchestrator.ts), not here. These functions assume the caller has already
// been authorized.

export async function createReviewer(
  actorId: string,
  dto: { email: string; password: string; fullName: string; phone?: string },
): Promise<{ id: string; email: string; fullName: string; role: string }> {
  const email = dto.email.toLowerCase().trim();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw new AppError(409, 'Email already registered');

  const passwordHash = await argon2Hash(dto.password);
  // Admin-provisioned accounts skip OTP — the admin is vouching for the email directly.
  const user = await prisma.user.create({
    data: {
      email, passwordHash, fullName: dto.fullName.trim(), phone: dto.phone,
      role: 'REVIEWER', emailVerified: true, isVerified: true,
    },
    select: { id: true, email: true, fullName: true, role: true },
  });

  await audit({ action: 'REVIEWER_CREATED', entity: 'User', entityId: user.id, actorId });
  return user;
}

export async function setUserActive(
  actorId: string,
  userId: string,
  isActive: boolean,
): Promise<{ id: string; email: string; isActive: boolean }> {
  const user = await prisma.user.update({
    where:  { id: userId },
    data:   { isActive },
    select: { id: true, email: true, isActive: true },
  });

  // Disabling a user mid-session should actually end their session, not just
  // block future logins — revoke any live refresh tokens immediately.
  if (!isActive) {
    await prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data:  { revokedAt: new Date() },
    });
  }

  await audit({
    action:   isActive ? 'USER_ENABLED' : 'USER_DISABLED',
    entity:   'User',
    entityId: userId,
    actorId,
  });
  return user;
}

export async function listUsers(role?: string) {
  return prisma.user.findMany({
    where:   role ? { role: role as 'APPLICANT' | 'REVIEWER' | 'ADMIN' } : undefined,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, email: true, fullName: true, phone: true, role: true,
      isActive: true, isVerified: true, emailVerified: true, createdAt: true,
    },
  });
}

export async function manageRole(
  actorId: string,
  userId: string,
  newRole: 'APPLICANT' | 'REVIEWER' | 'ADMIN',
): Promise<{ id: string; email: string; role: string }> {
  const user = await prisma.user.update({
    where:  { id: userId },
    data:   { role: newRole },
    select: { id: true, email: true, role: true },
  });

  await audit({
    action:   'ROLE_CHANGED',
    entity:   'User',
    entityId: userId,
    actorId,
    meta:     { newRole },
  });
  return user;
}
