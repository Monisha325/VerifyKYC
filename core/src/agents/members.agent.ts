import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { z } from 'zod/v3';
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

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: true };

const text = (data: unknown): ToolResult =>
  ({ content: [{ type: 'text', text: JSON.stringify(data) }] });

const toolError = (e: unknown): ToolResult =>
  ({ content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true });

// ── Standalone handlers — callable both via MCP transport and directly ─────────

export const membersTools: Record<string, (args: Record<string, unknown>) => Promise<ToolResult>> = {
  get_review_queue: async (_args) => {
    try {
      return text(await getQueue());
    } catch (e) { return toolError(e); }
  },

  get_evidence_bundle: async (args) => {
    const { applicationId } = args as { applicationId: string };
    try {
      return text(await getEvidenceBundle(applicationId));
    } catch (e) { return toolError(e); }
  },

  claim_application: async (args) => {
    const { applicationId, reviewerId } = args as { applicationId: string; reviewerId: string };
    try {
      return text(await claimApplication(applicationId, reviewerId));
    } catch (e) { return toolError(e); }
  },

  submit_decision: async (args) => {
    const { applicationId, reviewerId, reviewerRole, decision, reasonCodes, notes } = args as {
      applicationId: string;
      reviewerId:    string;
      reviewerRole:  string;
      decision:      'APPROVED' | 'REJECTED' | 'ESCALATED';
      reasonCodes:   (typeof REASON_CODES)[number][];
      notes?:        string;
    };
    try {
      return text(await recordDecision(applicationId, reviewerId, reviewerRole, { decision, reasonCodes, notes }));
    } catch (e) { return toolError(e); }
  },

  get_audit_trail: async (args) => {
    const { entity, entityId } = args as { entity: string; entityId: string };
    try {
      return text(await getEntityHistory(entity, entityId));
    } catch (e) { return toolError(e); }
  },

  // ── ADMIN-only — enforced by the agent dispatch layer (orchestrator.ts) ──
  // NB: `userId` here is auto-injected by agent.router.ts as the *caller's*
  // own id (req.user.sub) — that's exactly what we want for the actor/audit
  // trail, but it means the *target* user being acted on must use a
  // differently-named field (targetUserId), or it would be silently
  // clobbered by the caller's own id on every request.

  create_reviewer: async (args) => {
    const { userId: actorId, email, password, fullName, phone } = args as {
      userId: string; email: string; password: string; fullName: string; phone?: string;
    };
    try {
      return text(await createReviewerService(actorId, { email, password, fullName, phone }));
    } catch (e) { return toolError(e); }
  },

  disable_reviewer: async (args) => {
    const { userId: actorId, targetUserId } = args as { userId: string; targetUserId: string };
    try {
      return text(await setUserActive(actorId, targetUserId, false));
    } catch (e) { return toolError(e); }
  },

  enable_reviewer: async (args) => {
    const { userId: actorId, targetUserId } = args as { userId: string; targetUserId: string };
    try {
      return text(await setUserActive(actorId, targetUserId, true));
    } catch (e) { return toolError(e); }
  },

  list_users: async (args) => {
    // NB: named roleFilter, not role — agent.router.ts always injects a
    // top-level `role` field holding the *caller's own* role for access
    // checks, which would silently clobber a same-named filter argument.
    const { roleFilter } = args as { roleFilter?: string };
    try {
      return text(await listUsersService(roleFilter));
    } catch (e) { return toolError(e); }
  },

  manage_roles: async (args) => {
    const { userId: actorId, targetUserId, newRole } = args as {
      userId: string; targetUserId: string; newRole: 'APPLICANT' | 'REVIEWER' | 'ADMIN';
    };
    try {
      return text(await manageRoleService(actorId, targetUserId, newRole));
    } catch (e) { return toolError(e); }
  },

  system_audit_logs: async (args) => {
    const { limit } = args as { limit?: number };
    try {
      return text(await getRecentAuditEvents(limit));
    } catch (e) { return toolError(e); }
  },
};

// ── MCP server — delegates to membersTools ─────────────────────────────────────

export const membersAgent = new McpServer({ name: 'members-agent', version: '1.0.0' });

membersAgent.tool(
  'get_review_queue',
  'Return all PENDING_REVIEW applications sorted by risk: FLAGGED band first, then highest flag count, then newest.',
  async () => membersTools.get_review_queue({}),
);

membersAgent.tool(
  'get_evidence_bundle',
  'Fetch the full evidence bundle for a PENDING_REVIEW application: documents with short-lived signed URLs, extracted fields, fraud flags, identity correlation scores, and prior decisions.',
  {
    applicationId: z.string(),
  },
  (args) => membersTools.get_evidence_bundle(args),
);

membersAgent.tool(
  'claim_application',
  'Claim a PENDING_REVIEW application for review. Idempotent if already claimed by the same reviewer. Throws 409 if claimed by someone else.',
  {
    applicationId: z.string(),
    reviewerId:    z.string(),
  },
  (args) => membersTools.claim_application(args),
);

membersAgent.tool(
  'submit_decision',
  'Record a reviewer decision on a claimed application. ADMIN can decide without claiming; REVIEWER must claim first. At least one reason code is required.',
  {
    applicationId: z.string(),
    reviewerId:    z.string(),
    reviewerRole:  z.string(),
    decision:      z.enum(['APPROVED', 'REJECTED', 'ESCALATED']),
    reasonCodes:   z.array(z.enum(REASON_CODES)).min(1),
    notes:         z.string().max(2000).optional(),
  },
  (args) => membersTools.submit_decision(args),
);

membersAgent.tool(
  'get_audit_trail',
  'Return the full audit history for a given entity and entityId (e.g. entity="KycApplication", entityId="<uuid>"), ordered oldest first.',
  {
    entity:   z.string(),
    entityId: z.string(),
  },
  (args) => membersTools.get_audit_trail(args),
);

// ── ADMIN-only tools ───────────────────────────────────────────────────────────

membersAgent.tool(
  'create_reviewer',
  'ADMIN-only. Create a new REVIEWER account. Skips email OTP verification — the admin vouches for the email directly. userId is the acting admin (audit trail), auto-filled from the session when called via chat.',
  {
    userId:   z.string(),
    email:    z.string().email(),
    password: z.string().min(8).max(128),
    fullName: z.string().min(2).max(100),
    phone:    z.string().optional(),
  },
  (args) => membersTools.create_reviewer(args),
);

membersAgent.tool(
  'disable_reviewer',
  'ADMIN-only. Disable a user account — blocks future logins and immediately revokes any active sessions. userId is the acting admin (audit trail); targetUserId is the account being disabled.',
  {
    userId:       z.string(),
    targetUserId: z.string(),
  },
  (args) => membersTools.disable_reviewer(args),
);

membersAgent.tool(
  'enable_reviewer',
  'ADMIN-only. Re-enable a previously disabled user account. userId is the acting admin (audit trail); targetUserId is the account being re-enabled.',
  {
    userId:       z.string(),
    targetUserId: z.string(),
  },
  (args) => membersTools.enable_reviewer(args),
);

membersAgent.tool(
  'list_users',
  'ADMIN-only. List all user accounts, optionally filtered by role (APPLICANT|REVIEWER|ADMIN).',
  {
    roleFilter: z.enum(['APPLICANT', 'REVIEWER', 'ADMIN']).optional(),
  },
  (args) => membersTools.list_users(args),
);

membersAgent.tool(
  'manage_roles',
  'ADMIN-only. Change a user\'s role. userId is the acting admin (audit trail); targetUserId is the account whose role is changing.',
  {
    userId:       z.string(),
    targetUserId: z.string(),
    newRole:      z.enum(['APPLICANT', 'REVIEWER', 'ADMIN']),
  },
  (args) => membersTools.manage_roles(args),
);

membersAgent.tool(
  'system_audit_logs',
  'ADMIN-only. Return the most recent audit events system-wide (not scoped to one entity), newest first. Default limit 100, max 500.',
  {
    limit: z.number().int().positive().max(500).optional(),
  },
  (args) => membersTools.system_audit_logs(args),
);
