import { z } from 'zod';

// Trims + lowercases before validation, then checks standard email format.
const validEmail = (label = 'Invalid email address') =>
  z.preprocess(
    (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v),
    z.string().email(label)
  );

export const RegisterSchema = z.object({
  email: validEmail('Invalid email address'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password too long'),
  fullName: z.string().min(2, 'Full name required').max(100).trim(),
  phone: z.string().optional(),
});

export const LoginSchema = z.object({
  email: validEmail(),
  password: z.string().min(1, 'Password required'),
});

export const VerifyEmailSchema = z.object({
  email: validEmail('Invalid email address'),
  otp:   z.string().length(6, 'OTP must be 6 digits').regex(/^\d{6}$/, 'OTP must be numeric'),
});

export const ResendOtpSchema = z.object({
  email: validEmail('Invalid email address'),
});

export type RegisterDto    = z.infer<typeof RegisterSchema>;
export type LoginDto       = z.infer<typeof LoginSchema>;
export type VerifyEmailDto = z.infer<typeof VerifyEmailSchema>;
export type ResendOtpDto   = z.infer<typeof ResendOtpSchema>;
