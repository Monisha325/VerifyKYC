// ── LangChain tool wrappers — all 30 tools across auth/kyc/members ────────────
// Each tool wraps dispatchTool() (the exact same RBAC-enforcement path used by
// direct button clicks). The LangChain layer never performs its own role check —
// it only supplies arguments; dispatchTool rejects unauthorized calls the same
// way it would for any other caller.
//
// Session fields (userId, role, reviewerId, reviewerRole) are injected from
// LangChain's configurable context — the same values agent.router.ts stamped
// from the verified JWT. Tool schemas intentionally omit these fields so the
// model is never asked to supply identity it cannot know.

import { DynamicStructuredTool } from '@langchain/core/tools';
import type { RunnableConfig }    from '@langchain/core/runnables';
import { z }                      from 'zod';
import { dispatchTool }           from './tool.dispatch';

// Extract session context from LangChain's configurable — never from tool args.
function sessionCtx(config: RunnableConfig | undefined) {
  const c = config?.configurable ?? {};
  return {
    userId:       c.userId       as string | undefined,
    role:         c.role         as string | undefined,
    reviewerId:   c.reviewerId   as string | undefined,
    reviewerRole: c.reviewerRole as string | undefined,
  };
}

// Single execution path — mirrors orchestrator.ts Path A.
async function invoke(
  name:   string,
  args:   Record<string, unknown>,
  config: RunnableConfig | undefined,
): Promise<string> {
  const session = sessionCtx(config);
  const result  = await dispatchTool(name, { ...args, ...session }, session.role);
  return result.isError
    ? `Error: ${result.content[0]?.text ?? 'unknown error'}`
    : (result.content[0]?.text ?? '');
}

// ── Authentication tools (11) ─────────────────────────────────────────────────

export const authLcTools: DynamicStructuredTool[] = [
  new DynamicStructuredTool({
    name:        'register_user',
    description: 'Register a new user account. Sends a 6-digit OTP to the email for verification.',
    schema: z.object({
      email:    z.string().email(),
      password: z.string().min(8).max(128),
      fullName: z.string().min(2).max(100),
      phone:    z.string().optional(),
    }),
    func: async (a, _rm, cfg) => invoke('register_user', a as Record<string, unknown>, cfg),
  }),

  new DynamicStructuredTool({
    name:        'login_user',
    description: 'Authenticate with email and password. Returns accessToken and user profile.',
    schema: z.object({
      email:    z.string().email(),
      password: z.string(),
    }),
    func: async (a, _rm, cfg) => invoke('login_user', a as Record<string, unknown>, cfg),
  }),

  new DynamicStructuredTool({
    name:        'verify_email',
    description: 'Verify a newly registered email address using the 6-digit OTP.',
    schema: z.object({
      email: z.string().email(),
      otp:   z.string().length(6),
    }),
    func: async (a, _rm, cfg) => invoke('verify_email', a as Record<string, unknown>, cfg),
  }),

  new DynamicStructuredTool({
    name:        'resend_otp',
    description: 'Resend the email verification OTP to the given address.',
    schema: z.object({ email: z.string().email() }),
    func: async (a, _rm, cfg) => invoke('resend_otp', a as Record<string, unknown>, cfg),
  }),

  new DynamicStructuredTool({
    name:        'refresh_token',
    description: 'Rotate a refresh token. The old token is immediately revoked.',
    schema: z.object({ refreshToken: z.string() }),
    func: async (a, _rm, cfg) => invoke('refresh_token', a as Record<string, unknown>, cfg),
  }),

  new DynamicStructuredTool({
    name:        'logout',
    description: 'Revoke a refresh token and end the session.',
    schema: z.object({
      refreshToken: z.string().optional(),
      actorId:      z.string().optional(),
    }),
    func: async (a, _rm, cfg) => invoke('logout', a as Record<string, unknown>, cfg),
  }),

  new DynamicStructuredTool({
    name:        'get_current_user',
    description: 'Return the full profile for the current authenticated user.',
    schema:       z.object({}),
    func: async (_a, _rm, cfg) => invoke('get_current_user', {}, cfg),
  }),

  new DynamicStructuredTool({
    name:        'forgot_password',
    description: 'Request a password reset link. Returns a generic confirmation regardless of whether the email exists.',
    schema: z.object({ email: z.string().email() }),
    func: async (a, _rm, cfg) => invoke('forgot_password', a as Record<string, unknown>, cfg),
  }),

  new DynamicStructuredTool({
    name:        'reset_password',
    description: 'Reset a password using the token emailed by forgot_password. Revokes all existing sessions.',
    schema: z.object({
      resetToken:  z.string(),
      newPassword: z.string().min(8).max(128),
    }),
    func: async (a, _rm, cfg) => invoke('reset_password', a as Record<string, unknown>, cfg),
  }),

  new DynamicStructuredTool({
    name:        'change_password',
    description: 'Change the password for the current user. Requires the current password. Revokes all sessions.',
    schema: z.object({
      currentPassword: z.string(),
      newPassword:     z.string().min(8).max(128),
    }),
    func: async (a, _rm, cfg) => invoke('change_password', a as Record<string, unknown>, cfg),
  }),

  new DynamicStructuredTool({
    name:        'update_profile',
    description: "Update the current user's fullName and/or phone. Only the provided fields are changed.",
    schema: z.object({
      fullName: z.string().min(2).max(100).optional(),
      phone:    z.string().optional(),
    }),
    func: async (a, _rm, cfg) => invoke('update_profile', a as Record<string, unknown>, cfg),
  }),
];

// ── KYC Agent tools (8) ───────────────────────────────────────────────────────

export const kycLcTools: DynamicStructuredTool[] = [
  new DynamicStructuredTool({
    name:        'create_application',
    description: 'Create a new DRAFT KYC application for the current user. Fails if an active application already exists.',
    schema:       z.object({}),
    func: async (_a, _rm, cfg) => invoke('create_application', {}, cfg),
  }),

  new DynamicStructuredTool({
    name:        'get_upload_params',
    description: 'Generate signed Cloudinary upload parameters for a document kind. Caller uploads directly to Cloudinary, then calls register_document.',
    schema: z.object({
      applicationId: z.string(),
      documentKind:  z.enum(['AADHAAR', 'PAN', 'PASSPORT', 'DRIVING_LICENCE', 'SELFIE']),
    }),
    func: async (a, _rm, cfg) => invoke('get_upload_params', a as Record<string, unknown>, cfg),
  }),

  new DynamicStructuredTool({
    name:        'register_document',
    description: 'Register an already-uploaded Cloudinary document against a DRAFT application.',
    schema: z.object({
      applicationId: z.string(),
      documentKind:  z.enum(['AADHAAR', 'PAN', 'PASSPORT', 'DRIVING_LICENCE', 'SELFIE']),
      publicId:      z.string().min(1),
      secureUrl:     z.string().url(),
      sha256:        z.string().regex(/^[a-f0-9]{64}$/),
    }),
    func: async (a, _rm, cfg) => invoke('register_document', a as Record<string, unknown>, cfg),
  }),

  new DynamicStructuredTool({
    name:        'submit_application',
    description: 'Submit a DRAFT application and enqueue the AI verification pipeline. Poll get_application_status to track progress.',
    schema: z.object({ applicationId: z.string() }),
    func: async (a, _rm, cfg) => invoke('submit_application', a as Record<string, unknown>, cfg),
  }),

  new DynamicStructuredTool({
    name:        'get_application_status',
    description: "Lightweight status poll. If applicationId is omitted, uses the user's most recent application.",
    schema: z.object({ applicationId: z.string().optional() }),
    func: async (a, _rm, cfg) => invoke('get_application_status', a as Record<string, unknown>, cfg),
  }),

  new DynamicStructuredTool({
    name:        'get_application',
    description: "Fetch the full application record including documents and review decision. If applicationId is omitted, uses the user's most recent.",
    schema: z.object({ applicationId: z.string().optional() }),
    func: async (a, _rm, cfg) => invoke('get_application', a as Record<string, unknown>, cfg),
  }),

  new DynamicStructuredTool({
    name:        'get_document',
    description: 'Fetch a single document with its extracted fields and AI verification results.',
    schema: z.object({ documentId: z.string() }),
    func: async (a, _rm, cfg) => invoke('get_document', a as Record<string, unknown>, cfg),
  }),

  new DynamicStructuredTool({
    name:        'cancel_application',
    description: 'Cancel a REJECTED application so the user can re-apply. Only REJECTED applications can be cancelled.',
    schema: z.object({ applicationId: z.string() }),
    func: async (a, _rm, cfg) => invoke('cancel_application', a as Record<string, unknown>, cfg),
  }),
];

// ── Members tools (11) ────────────────────────────────────────────────────────

export const membersLcTools: DynamicStructuredTool[] = [
  new DynamicStructuredTool({
    name:        'get_review_queue',
    description: 'Return all PENDING_REVIEW applications sorted by risk: flagged band first, then highest flag count, then newest.',
    schema:       z.object({}),
    func: async (_a, _rm, cfg) => invoke('get_review_queue', {}, cfg),
  }),

  new DynamicStructuredTool({
    name:        'get_evidence_bundle',
    description: 'Fetch the full evidence bundle for a PENDING_REVIEW application: documents, extracted fields, fraud flags, identity correlation scores, prior decisions.',
    schema: z.object({ applicationId: z.string() }),
    func: async (a, _rm, cfg) => invoke('get_evidence_bundle', a as Record<string, unknown>, cfg),
  }),

  new DynamicStructuredTool({
    name:        'claim_application',
    description: 'Claim a PENDING_REVIEW application for review. Idempotent if already claimed by the same reviewer.',
    schema: z.object({ applicationId: z.string() }),
    func: async (a, _rm, cfg) => invoke('claim_application', a as Record<string, unknown>, cfg),
  }),

  new DynamicStructuredTool({
    name:        'submit_decision',
    description: 'Record a reviewer decision (APPROVED/REJECTED/ESCALATED) on a claimed application. Requires at least one reason code.',
    schema: z.object({
      applicationId: z.string(),
      decision:      z.enum(['APPROVED', 'REJECTED', 'ESCALATED']),
      reasonCodes:   z.array(z.string()).min(1),
      notes:         z.string().max(2000).optional(),
    }),
    func: async (a, _rm, cfg) => invoke('submit_decision', a as Record<string, unknown>, cfg),
  }),

  new DynamicStructuredTool({
    name:        'get_audit_trail',
    description: 'Return the full audit history for a given entity and entityId, ordered oldest first.',
    schema: z.object({
      entity:   z.string(),
      entityId: z.string(),
    }),
    func: async (a, _rm, cfg) => invoke('get_audit_trail', a as Record<string, unknown>, cfg),
  }),

  new DynamicStructuredTool({
    name:        'create_reviewer',
    description: 'ADMIN only. Create a new REVIEWER account, bypassing email OTP verification.',
    schema: z.object({
      email:    z.string().email(),
      password: z.string().min(8).max(128),
      fullName: z.string().min(2).max(100),
      phone:    z.string().optional(),
    }),
    func: async (a, _rm, cfg) => invoke('create_reviewer', a as Record<string, unknown>, cfg),
  }),

  new DynamicStructuredTool({
    name:        'disable_reviewer',
    description: 'ADMIN only. Disable a user account — blocks future logins and revokes active sessions.',
    schema: z.object({ targetUserId: z.string() }),
    func: async (a, _rm, cfg) => invoke('disable_reviewer', a as Record<string, unknown>, cfg),
  }),

  new DynamicStructuredTool({
    name:        'enable_reviewer',
    description: 'ADMIN only. Re-enable a previously disabled user account.',
    schema: z.object({ targetUserId: z.string() }),
    func: async (a, _rm, cfg) => invoke('enable_reviewer', a as Record<string, unknown>, cfg),
  }),

  new DynamicStructuredTool({
    name:        'list_users',
    description: 'ADMIN only. List all user accounts, optionally filtered by role.',
    schema: z.object({
      roleFilter: z.enum(['APPLICANT', 'REVIEWER', 'ADMIN']).optional(),
    }),
    func: async (a, _rm, cfg) => invoke('list_users', a as Record<string, unknown>, cfg),
  }),

  new DynamicStructuredTool({
    name:        'manage_roles',
    description: "ADMIN only. Change a user's role.",
    schema: z.object({
      targetUserId: z.string(),
      newRole:      z.enum(['APPLICANT', 'REVIEWER', 'ADMIN']),
    }),
    func: async (a, _rm, cfg) => invoke('manage_roles', a as Record<string, unknown>, cfg),
  }),

  new DynamicStructuredTool({
    name:        'system_audit_logs',
    description: 'ADMIN only. Return the most recent system-wide audit events, newest first. Default limit 100, max 500.',
    schema: z.object({
      limit: z.number().int().positive().max(500).optional(),
    }),
    func: async (a, _rm, cfg) => invoke('system_audit_logs', a as Record<string, unknown>, cfg),
  }),
];
