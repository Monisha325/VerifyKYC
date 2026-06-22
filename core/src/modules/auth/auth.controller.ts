import { Request, Response } from 'express';
import {
  RegisterSchema,
  LoginSchema,
  VerifyEmailSchema,
  ResendOtpSchema,
  ForgotPasswordSchema,
  ResetPasswordSchema,
} from './auth.schema';
import {
  registerUser,
  loginUser,
  verifyEmail   as verifyEmailService,
  resendOtp     as resendOtpService,
  rotateRefreshToken,
  logoutUser,
  forgotPassword as forgotPasswordService,
  resetPassword  as resetPasswordService,
} from './auth.service';
import { AppError } from '../../middleware/errorHandler';
import { prisma }   from '../../utils/prisma';

export async function register(req: Request, res: Response) {
  const dto    = RegisterSchema.parse(req.body);
  const result = await registerUser(dto, req.ip);
  res.status(201).json(result);
}

export async function login(req: Request, res: Response) {
  const dto    = LoginSchema.parse(req.body);
  const result = await loginUser(dto, res, req.ip);
  res.json(result);
}

export async function verifyEmail(req: Request, res: Response) {
  const dto    = VerifyEmailSchema.parse(req.body);
  const result = await verifyEmailService(dto, res, req.ip);
  res.json(result);
}

export async function resendOtp(req: Request, res: Response) {
  const dto    = ResendOtpSchema.parse(req.body);
  const result = await resendOtpService(dto);
  res.json(result);
}

export async function forgotPassword(req: Request, res: Response) {
  const dto    = ForgotPasswordSchema.parse(req.body);
  const result = await forgotPasswordService(dto);
  res.json(result);
}

export async function resetPassword(req: Request, res: Response) {
  const dto    = ResetPasswordSchema.parse(req.body);
  const result = await resetPasswordService(dto);
  res.json(result);
}

export async function refresh(req: Request, res: Response) {
  const raw = req.cookies?.verikyc_rt as string | undefined;
  if (!raw) throw new AppError(401, 'No refresh token provided');
  const result = await rotateRefreshToken(raw, res, req.ip);
  res.json(result);
}

export async function logout(req: Request, res: Response) {
  const raw     = req.cookies?.verikyc_rt as string | undefined;
  const actorId = req.user?.sub;
  await logoutUser(raw, actorId, res, req.ip);
  res.json({ message: 'Logged out successfully' });
}

export async function me(req: Request, res: Response) {
  const user = await prisma.user.findUniqueOrThrow({
    where:  { id: req.user!.sub },
    select: { id: true, email: true, fullName: true, role: true, isVerified: true, emailVerified: true, createdAt: true },
  });
  res.json(user);
}
