import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { z } from 'zod/v3';
import type { Response } from 'express';
import {
  registerUser,
  loginUser,
  verifyEmail    as verifyEmailService,
  resendOtp      as resendOtpService,
  rotateRefreshToken,
  logoutUser,
  forgotPassword as forgotPasswordService,
  resetPassword  as resetPasswordService,
  changePassword as changePasswordService,
  updateProfile  as updateProfileService,
} from '../modules/auth/auth.service';
import { verifyAccessToken } from '../lib/token.service';
import { prisma } from '../utils/prisma';

// auth.service functions that issue tokens call res.cookie() to set the refresh
// token as an HttpOnly cookie. MCP tools have no HTTP response, so we pass a
// minimal mock that captures the raw value so it can be returned in the tool result.
function captureRes(): { res: Response; refreshToken(): string | undefined } {
  let captured: string | undefined;
  const res = {
    cookie(_name: string, value: string) { captured = value; },
    clearCookie() {},
  } as unknown as Response;
  return { res, refreshToken: () => captured };
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: true };

const text = (data: unknown): ToolResult =>
  ({ content: [{ type: 'text', text: JSON.stringify(data) }] });

const toolError = (e: unknown): ToolResult =>
  ({ content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true });

// ── Standalone handlers — callable both via MCP transport and directly ─────────

export const authTools: Record<string, (args: Record<string, unknown>) => Promise<ToolResult>> = {
  register_user: async (args) => {
    const a = args as { email: string; password: string; fullName: string; phone?: string };
    try {
      return text(await registerUser(a));
    } catch (e) { return toolError(e); }
  },

  login_user: async (args) => {
    const a = args as { email: string; password: string };
    try {
      const { res, refreshToken } = captureRes();
      const result = await loginUser(a, res);
      return text({ ...result, refreshToken: refreshToken() });
    } catch (e) { return toolError(e); }
  },

  verify_email: async (args) => {
    const a = args as { email: string; otp: string };
    try {
      const { res, refreshToken } = captureRes();
      const result = await verifyEmailService(a, res);
      return text({ ...result, refreshToken: refreshToken() });
    } catch (e) { return toolError(e); }
  },

  resend_otp: async (args) => {
    const a = args as { email: string };
    try {
      return text(await resendOtpService(a));
    } catch (e) { return toolError(e); }
  },

  refresh_token: async (args) => {
    const { refreshToken } = args as { refreshToken: string };
    try {
      const { res, refreshToken: newRt } = captureRes();
      const result = await rotateRefreshToken(refreshToken, res);
      return text({ ...result, refreshToken: newRt() });
    } catch (e) { return toolError(e); }
  },

  logout: async (args) => {
    const { refreshToken, actorId } = args as { refreshToken?: string; actorId?: string };
    try {
      const { res } = captureRes();
      await logoutUser(refreshToken, actorId, res);
      return text({ message: 'Logged out successfully' });
    } catch (e) { return toolError(e); }
  },

  get_current_user: async (args) => {
    const { accessToken } = args as { accessToken: string };
    try {
      const payload = verifyAccessToken(accessToken);
      const user = await prisma.user.findUniqueOrThrow({
        where:  { id: payload.sub },
        select: { id: true, email: true, fullName: true, role: true, isVerified: true, emailVerified: true, createdAt: true },
      });
      return text(user);
    } catch (e) { return toolError(e); }
  },

  forgot_password: async (args) => {
    const a = args as { email: string };
    try {
      return text(await forgotPasswordService(a));
    } catch (e) { return toolError(e); }
  },

  reset_password: async (args) => {
    const a = args as { resetToken: string; newPassword: string };
    try {
      return text(await resetPasswordService(a));
    } catch (e) { return toolError(e); }
  },

  change_password: async (args) => {
    const { userId, currentPassword, newPassword } = args as {
      userId: string; currentPassword: string; newPassword: string;
    };
    try {
      return text(await changePasswordService(userId, { currentPassword, newPassword }));
    } catch (e) { return toolError(e); }
  },

  update_profile: async (args) => {
    const { userId, fullName, phone } = args as { userId: string; fullName?: string; phone?: string };
    try {
      return text(await updateProfileService(userId, { fullName, phone }));
    } catch (e) { return toolError(e); }
  },
};

// ── MCP server — delegates to authTools so each handler is reachable directly ──

export const authAgent = new McpServer({ name: 'auth-agent', version: '1.0.0' });

authAgent.tool(
  'register_user',
  'Register a new user account. Returns a confirmation message. A 6-digit OTP is sent to the email address for verification.',
  {
    email:    z.string().email(),
    password: z.string().min(8).max(128),
    fullName: z.string().min(2).max(100),
    phone:    z.string().optional(),
  },
  (args) => authTools.register_user(args),
);

authAgent.tool(
  'login_user',
  'Authenticate with email and password. Returns accessToken, user profile, and refreshToken.',
  {
    email:    z.string().email(),
    password: z.string(),
  },
  (args) => authTools.login_user(args),
);

authAgent.tool(
  'verify_email',
  'Verify a newly registered email address using the 6-digit OTP. Returns accessToken, user profile, and refreshToken.',
  {
    email: z.string().email(),
    otp:   z.string().length(6).regex(/^\d{6}$/),
  },
  (args) => authTools.verify_email(args),
);

authAgent.tool(
  'resend_otp',
  'Resend the email verification OTP to the given address.',
  {
    email: z.string().email(),
  },
  (args) => authTools.resend_otp(args),
);

authAgent.tool(
  'refresh_token',
  'Rotate a refresh token. The old token is immediately revoked. Returns a new accessToken and a new refreshToken.',
  {
    refreshToken: z.string(),
  },
  (args) => authTools.refresh_token(args),
);

authAgent.tool(
  'logout',
  'Revoke a refresh token and end the session. Both refreshToken and actorId are optional — passing neither still clears the session client-side.',
  {
    refreshToken: z.string().optional(),
    actorId:      z.string().optional(),
  },
  (args) => authTools.logout(args),
);

authAgent.tool(
  'get_current_user',
  'Verify an access token and return the full user profile.',
  {
    accessToken: z.string(),
  },
  (args) => authTools.get_current_user(args),
);

authAgent.tool(
  'forgot_password',
  'Request a password reset. Always returns a generic confirmation message regardless of whether the email exists, to avoid leaking account existence. If the email is registered, a reset token is emailed.',
  {
    email: z.string().email(),
  },
  (args) => authTools.forgot_password(args),
);

authAgent.tool(
  'reset_password',
  'Reset a password using the token emailed by forgot_password. Expires after 30 minutes. Revokes all existing sessions for the account.',
  {
    resetToken:  z.string(),
    newPassword: z.string().min(8).max(128),
  },
  (args) => authTools.reset_password(args),
);

authAgent.tool(
  'change_password',
  'Change the password for the currently authenticated user. Requires the current password. Revokes all existing sessions, including the current one — the caller must log in again afterward.',
  {
    userId:          z.string(),
    currentPassword: z.string(),
    newPassword:     z.string().min(8).max(128),
  },
  (args) => authTools.change_password(args),
);

authAgent.tool(
  'update_profile',
  'Update the current user\'s fullName and/or phone. Both fields are optional — only the ones provided are changed.',
  {
    userId:   z.string(),
    fullName: z.string().min(2).max(100).optional(),
    phone:    z.string().optional(),
  },
  (args) => authTools.update_profile(args),
);
