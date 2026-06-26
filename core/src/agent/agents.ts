// ── Tool implementations + definitions for all three agent domains ─────────────
// Auth (11), KYC (8), Members (11) — single source of truth for tool logic,
// descriptions, and Zod schemas. MCP servers import from here; the LangChain
// tool wrappers in tools.ts call dispatchTool() which routes to these handlers.

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
import {
  createApplication,
  submitApplication,
  getApplication,
  cancelApplication,
} from '../modules/applications/application.service';
import {
  generateUploadParams,
  registerDocument,
} from '../modules/documents/document.service';
import { enqueueApplication } from '../modules/verification/orchestrator';
import {
  getQueue,
  getEvidenceBundle,
  claimApplication,
  recordDecision,
} from '../modules/review/review.service';
import { getEntityHistory, getRecentAuditEvents } from '../utils/audit';
import { REASON_CODES }    from '../modules/review/review.schema';
import {
  createReviewer as createReviewerService,
  setUserActive,
  listUsers       as listUsersService,
  manageRole      as manageRoleService,
} from '../modules/auth/auth.service';
import { prisma }    from '../utils/prisma';
import { AppError }  from '../middleware/errorHandler';

export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: true };

const text      = (data: unknown): ToolResult =>
  ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const toolError = (e: unknown): ToolResult =>
  ({ content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true });

// auth.service functions that issue tokens call res.cookie() — MCP tools have
// no HTTP response, so this mock captures the raw value for the tool result.
function captureRes(): { res: Response; refreshToken(): string | undefined } {
  let captured: string | undefined;
  const res = {
    cookie(_name: string, value: string) { captured = value; },
    clearCookie() {},
  } as unknown as Response;
  return { res, refreshToken: () => captured };
}

const DocKindEnum = z.enum(['AADHAAR', 'PAN', 'PASSPORT', 'DRIVING_LICENCE', 'SELFIE']);

// ── Auth tools ────────────────────────────────────────────────────────────────

export const authTools: Record<string, (args: Record<string, unknown>) => Promise<ToolResult>> = {
  register_user: async (args) => {
    const a = args as { email: string; password: string; fullName: string; phone?: string };
    try { return text(await registerUser(a)); } catch (e) { return toolError(e); }
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
    try { return text(await resendOtpService(a)); } catch (e) { return toolError(e); }
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
    const { userId } = args as { userId: string };
    try {
      const user = await prisma.user.findUniqueOrThrow({
        where:  { id: userId },
        select: { id: true, email: true, fullName: true, role: true, isVerified: true, emailVerified: true, createdAt: true },
      });
      return text(user);
    } catch (e) { return toolError(e); }
  },

  forgot_password: async (args) => {
    const a = args as { email: string };
    try { return text(await forgotPasswordService(a)); } catch (e) { return toolError(e); }
  },

  reset_password: async (args) => {
    const a = args as { resetToken: string; newPassword: string };
    try { return text(await resetPasswordService(a)); } catch (e) { return toolError(e); }
  },

  change_password: async (args) => {
    const { userId, currentPassword, newPassword } = args as { userId: string; currentPassword: string; newPassword: string };
    try { return text(await changePasswordService(userId, { currentPassword, newPassword })); } catch (e) { return toolError(e); }
  },

  update_profile: async (args) => {
    const { userId, fullName, phone } = args as { userId: string; fullName?: string; phone?: string };
    try { return text(await updateProfileService(userId, { fullName, phone })); } catch (e) { return toolError(e); }
  },
};

export const AUTH_TOOL_DEFS: Record<string, { description: string; schema: Record<string, z.ZodTypeAny> }> = {
  register_user: {
    description: 'Register a new user account. Returns a confirmation message. A 6-digit OTP is sent to the email address for verification.',
    schema: { email: z.string().email(), password: z.string().min(8).max(128), fullName: z.string().min(2).max(100), phone: z.string().optional() },
  },
  login_user: {
    description: 'Authenticate with email and password. Returns accessToken, user profile, and refreshToken.',
    schema: { email: z.string().email(), password: z.string() },
  },
  verify_email: {
    description: 'Verify a newly registered email address using the 6-digit OTP. Returns accessToken, user profile, and refreshToken.',
    schema: { email: z.string().email(), otp: z.string().length(6).regex(/^\d{6}$/) },
  },
  resend_otp: {
    description: 'Resend the email verification OTP to the given address.',
    schema: { email: z.string().email() },
  },
  refresh_token: {
    description: 'Rotate a refresh token. The old token is immediately revoked. Returns a new accessToken and a new refreshToken.',
    schema: { refreshToken: z.string() },
  },
  logout: {
    description: 'Revoke a refresh token and end the session.',
    schema: { refreshToken: z.string().optional(), actorId: z.string().optional() },
  },
  get_current_user: {
    description: 'Return the full profile for the given userId.',
    schema: { userId: z.string() },
  },
  forgot_password: {
    description: 'Request a password reset. Always returns a generic confirmation message. If the email is registered, a reset token is emailed.',
    schema: { email: z.string().email() },
  },
  reset_password: {
    description: 'Reset a password using the token emailed by forgot_password. Expires after 30 minutes. Revokes all existing sessions.',
    schema: { resetToken: z.string(), newPassword: z.string().min(8).max(128) },
  },
  change_password: {
    description: 'Change the password for the currently authenticated user. Requires the current password. Revokes all existing sessions.',
    schema: { userId: z.string(), currentPassword: z.string(), newPassword: z.string().min(8).max(128) },
  },
  update_profile: {
    description: "Update the current user's fullName and/or phone.",
    schema: { userId: z.string(), fullName: z.string().min(2).max(100).optional(), phone: z.string().optional() },
  },
};

// ── KYC tools ─────────────────────────────────────────────────────────────────

export const kycTools: Record<string, (args: Record<string, unknown>) => Promise<ToolResult>> = {
  create_application: async (args) => {
    const { userId } = args as { userId: string };
    try { return text(await createApplication(userId)); } catch (e) { return toolError(e); }
  },

  get_upload_params: async (args) => {
    const { applicationId, userId, documentKind } = args as { applicationId: string; userId: string; documentKind: string };
    try {
      return text(await generateUploadParams(applicationId, userId, { kind: documentKind as 'AADHAAR' | 'PAN' | 'PASSPORT' | 'DRIVING_LICENCE' | 'SELFIE' }));
    } catch (e) { return toolError(e); }
  },

  register_document: async (args) => {
    const { applicationId, userId, documentKind, publicId, secureUrl, sha256 } = args as { applicationId: string; userId: string; documentKind: string; publicId: string; secureUrl: string; sha256: string };
    try {
      return text(await registerDocument(applicationId, userId, {
        kind: documentKind as 'AADHAAR' | 'PAN' | 'PASSPORT' | 'DRIVING_LICENCE' | 'SELFIE',
        publicId, secureUrl, sha256,
      }));
    } catch (e) { return toolError(e); }
  },

  submit_application: async (args) => {
    const { applicationId, userId } = args as { applicationId: string; userId: string };
    try {
      await submitApplication(applicationId, userId);
      enqueueApplication(applicationId);
      return text({ applicationId, status: 'PROCESSING' });
    } catch (e) { return toolError(e); }
  },

  get_application_status: async (args) => {
    const { applicationId, userId, role } = args as { applicationId?: string; userId: string; role: string };
    try {
      let appId = applicationId;
      if (!appId && userId) {
        const apps = await prisma.kycApplication.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 1, select: { id: true } });
        appId = apps[0]?.id;
      }
      if (!appId) return { content: [{ type: 'text', text: JSON.stringify({ error: 'No application found' }) }], isError: true };
      const app = await getApplication(appId, userId, role ?? 'APPLICANT');
      return text({ id: app.id, status: app.status, overallScore: app.overallScore, scoreBand: app.scoreBand, submittedAt: app.submittedAt, updatedAt: app.updatedAt });
    } catch (e) { return toolError(e); }
  },

  get_application: async (args) => {
    const { applicationId, userId, role } = args as { applicationId?: string; userId: string; role: string };
    try {
      let appId = applicationId;
      if (!appId && userId) {
        const apps = await prisma.kycApplication.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 1, select: { id: true } });
        appId = apps[0]?.id;
      }
      if (!appId) return { content: [{ type: 'text', text: JSON.stringify({ error: 'No application found' }) }], isError: true };
      return text(await getApplication(appId, userId, role ?? 'APPLICANT'));
    } catch (e) { return toolError(e); }
  },

  get_document: async (args) => {
    const { documentId, userId, role } = args as { documentId: string; userId: string; role: string };
    try {
      const doc = await prisma.document.findUnique({ where: { id: documentId }, include: { extractedFields: true, documentVerification: true, application: { select: { userId: true } } } });
      if (!doc) throw new AppError(404, 'Document not found');
      if (role === 'APPLICANT' && doc.application.userId !== userId) throw new AppError(403, 'Access denied');
      return text(doc);
    } catch (e) { return toolError(e); }
  },

  cancel_application: async (args) => {
    const { userId, applicationId } = args as { userId: string; applicationId: string };
    try { return text(await cancelApplication(userId, applicationId)); } catch (e) { return toolError(e); }
  },
};

export const KYC_TOOL_DEFS: Record<string, { description: string; schema: Record<string, z.ZodTypeAny> }> = {
  create_application: {
    description: 'Create a new DRAFT KYC application for a user. Fails with 409 if the user already has an active application.',
    schema: { userId: z.string() },
  },
  get_upload_params: {
    description: 'Generate signed Cloudinary upload parameters for a document kind on a DRAFT application.',
    schema: { applicationId: z.string(), userId: z.string(), documentKind: DocKindEnum },
  },
  register_document: {
    description: 'Register an already-uploaded Cloudinary document against a DRAFT application.',
    schema: { applicationId: z.string(), userId: z.string(), documentKind: DocKindEnum, publicId: z.string().min(1), secureUrl: z.string().url().regex(/^https:\/\/res\.cloudinary\.com\//), sha256: z.string().regex(/^[a-f0-9]{64}$/) },
  },
  submit_application: {
    description: 'Submit a DRAFT application and enqueue the AI verification pipeline asynchronously.',
    schema: { applicationId: z.string(), userId: z.string() },
  },
  get_application_status: {
    description: "Lightweight status poll. If applicationId is omitted, looks up the user's most recent application automatically.",
    schema: { applicationId: z.string().optional(), userId: z.string(), role: z.string().optional() },
  },
  get_application: {
    description: "Fetch the full application record including documents and the latest review decision. If applicationId is omitted, looks up the user's most recent application automatically.",
    schema: { applicationId: z.string().optional(), userId: z.string(), role: z.string().optional() },
  },
  get_document: {
    description: 'Fetch a single document with its extracted fields and AI verification results.',
    schema: { documentId: z.string(), userId: z.string(), role: z.string() },
  },
  cancel_application: {
    description: 'Supersede a REJECTED application so the user can re-apply. Only REJECTED applications can be cancelled.',
    schema: { userId: z.string(), applicationId: z.string() },
  },
};

// ── Members tools ─────────────────────────────────────────────────────────────

export const membersTools: Record<string, (args: Record<string, unknown>) => Promise<ToolResult>> = {
  get_review_queue: async () => {
    try { return text(await getQueue()); } catch (e) { return toolError(e); }
  },

  get_evidence_bundle: async (args) => {
    const { applicationId } = args as { applicationId: string };
    try { return text(await getEvidenceBundle(applicationId)); } catch (e) { return toolError(e); }
  },

  claim_application: async (args) => {
    const { applicationId, reviewerId } = args as { applicationId: string; reviewerId: string };
    try { return text(await claimApplication(applicationId, reviewerId)); } catch (e) { return toolError(e); }
  },

  submit_decision: async (args) => {
    const { applicationId, reviewerId, reviewerRole, decision, reasonCodes, notes } = args as { applicationId: string; reviewerId: string; reviewerRole: string; decision: 'APPROVED' | 'REJECTED' | 'ESCALATED'; reasonCodes: (typeof REASON_CODES)[number][]; notes?: string };
    try { return text(await recordDecision(applicationId, reviewerId, reviewerRole, { decision, reasonCodes, notes })); } catch (e) { return toolError(e); }
  },

  get_audit_trail: async (args) => {
    const { entity, entityId } = args as { entity: string; entityId: string };
    try { return text(await getEntityHistory(entity, entityId)); } catch (e) { return toolError(e); }
  },

  create_reviewer: async (args) => {
    const { userId: actorId, email, password, fullName, phone } = args as { userId: string; email: string; password: string; fullName: string; phone?: string };
    try { return text(await createReviewerService(actorId, { email, password, fullName, phone })); } catch (e) { return toolError(e); }
  },

  disable_reviewer: async (args) => {
    const { userId: actorId, targetUserId } = args as { userId: string; targetUserId: string };
    try { return text(await setUserActive(actorId, targetUserId, false)); } catch (e) { return toolError(e); }
  },

  enable_reviewer: async (args) => {
    const { userId: actorId, targetUserId } = args as { userId: string; targetUserId: string };
    try { return text(await setUserActive(actorId, targetUserId, true)); } catch (e) { return toolError(e); }
  },

  list_users: async (args) => {
    const { roleFilter } = args as { roleFilter?: string };
    try { return text(await listUsersService(roleFilter)); } catch (e) { return toolError(e); }
  },

  manage_roles: async (args) => {
    const { userId: actorId, targetUserId, newRole } = args as { userId: string; targetUserId: string; newRole: 'APPLICANT' | 'REVIEWER' | 'ADMIN' };
    try { return text(await manageRoleService(actorId, targetUserId, newRole)); } catch (e) { return toolError(e); }
  },

  system_audit_logs: async (args) => {
    const { limit } = args as { limit?: number };
    try { return text(await getRecentAuditEvents(limit)); } catch (e) { return toolError(e); }
  },
};

export const MEMBERS_TOOL_DEFS: Record<string, { description: string; schema: Record<string, z.ZodTypeAny> }> = {
  get_review_queue: {
    description: 'Return all PENDING_REVIEW applications sorted by risk: FLAGGED band first, then highest flag count, then newest.',
    schema: {},
  },
  get_evidence_bundle: {
    description: 'Fetch the full evidence bundle for a PENDING_REVIEW application: documents, extracted fields, fraud flags, identity correlation scores, and prior decisions.',
    schema: { applicationId: z.string() },
  },
  claim_application: {
    description: 'Claim a PENDING_REVIEW application for review. Idempotent if already claimed by the same reviewer. Throws 409 if claimed by someone else.',
    schema: { applicationId: z.string(), reviewerId: z.string() },
  },
  submit_decision: {
    description: 'Record a reviewer decision on a claimed application. ADMIN can decide without claiming; REVIEWER must claim first. At least one reason code is required.',
    schema: { applicationId: z.string(), reviewerId: z.string(), reviewerRole: z.string(), decision: z.enum(['APPROVED', 'REJECTED', 'ESCALATED']), reasonCodes: z.array(z.enum(REASON_CODES)).min(1), notes: z.string().max(2000).optional() },
  },
  get_audit_trail: {
    description: 'Return the full audit history for a given entity and entityId, ordered oldest first.',
    schema: { entity: z.string(), entityId: z.string() },
  },
  create_reviewer: {
    description: 'ADMIN-only. Create a new REVIEWER account. Skips email OTP verification.',
    schema: { userId: z.string(), email: z.string().email(), password: z.string().min(8).max(128), fullName: z.string().min(2).max(100), phone: z.string().optional() },
  },
  disable_reviewer: {
    description: 'ADMIN-only. Disable a user account — blocks future logins and revokes active sessions.',
    schema: { userId: z.string(), targetUserId: z.string() },
  },
  enable_reviewer: {
    description: 'ADMIN-only. Re-enable a previously disabled user account.',
    schema: { userId: z.string(), targetUserId: z.string() },
  },
  list_users: {
    description: 'ADMIN-only. List all user accounts, optionally filtered by role.',
    schema: { roleFilter: z.enum(['APPLICANT', 'REVIEWER', 'ADMIN']).optional() },
  },
  manage_roles: {
    description: "ADMIN-only. Change a user's role.",
    schema: { userId: z.string(), targetUserId: z.string(), newRole: z.enum(['APPLICANT', 'REVIEWER', 'ADMIN']) },
  },
  system_audit_logs: {
    description: 'ADMIN-only. Return the most recent audit events system-wide, newest first. Default limit 100, max 500.',
    schema: { limit: z.number().int().positive().max(500).optional() },
  },
};
