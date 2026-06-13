import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { z } from 'zod/v3';
import {
  getQueue,
  getEvidenceBundle,
  claimApplication,
  recordDecision,
} from '../modules/review/review.service';
import { getEntityHistory } from '../utils/audit';
import { REASON_CODES }    from '../modules/review/review.schema';

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
