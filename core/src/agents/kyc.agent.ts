import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { z } from 'zod/v3';
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
import { prisma }    from '../utils/prisma';
import { AppError }  from '../middleware/errorHandler';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: true };

const text = (data: unknown): ToolResult =>
  ({ content: [{ type: 'text', text: JSON.stringify(data) }] });

const toolError = (e: unknown): ToolResult =>
  ({ content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true });

const DocKindEnum = z.enum(['AADHAAR', 'PAN', 'PASSPORT', 'DRIVING_LICENCE', 'SELFIE']);

// ── Standalone handlers — callable both via MCP transport and directly ─────────

export const kycTools: Record<string, (args: Record<string, unknown>) => Promise<ToolResult>> = {
  create_application: async (args) => {
    const { userId } = args as { userId: string };
    try {
      return text(await createApplication(userId));
    } catch (e) { return toolError(e); }
  },

  get_upload_params: async (args) => {
    const { applicationId, userId, documentKind } = args as {
      applicationId: string;
      userId:        string;
      documentKind:  string;
    };
    try {
      return text(await generateUploadParams(applicationId, userId, { kind: documentKind as 'AADHAAR' | 'PAN' | 'PASSPORT' | 'DRIVING_LICENCE' | 'SELFIE' }));
    } catch (e) { return toolError(e); }
  },

  register_document: async (args) => {
    const { applicationId, userId, documentKind, publicId, secureUrl, sha256 } = args as {
      applicationId: string;
      userId:        string;
      documentKind:  string;
      publicId:      string;
      secureUrl:     string;
      sha256:        string;
    };
    try {
      return text(await registerDocument(applicationId, userId, {
        kind:      documentKind as 'AADHAAR' | 'PAN' | 'PASSPORT' | 'DRIVING_LICENCE' | 'SELFIE',
        publicId,
        secureUrl,
        sha256,
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
        const apps = await prisma.kycApplication.findMany({
          where:   { userId },
          orderBy: { createdAt: 'desc' },
          take:    1,
          select:  { id: true },
        });
        appId = apps[0]?.id;
      }
      if (!appId) return { content: [{ type: 'text', text: JSON.stringify({ error: 'No application found' }) }], isError: true };
      const app = await getApplication(appId, userId, role ?? 'APPLICANT');
      return text({
        id:           app.id,
        status:       app.status,
        overallScore: app.overallScore,
        scoreBand:    app.scoreBand,
        submittedAt:  app.submittedAt,
        updatedAt:    app.updatedAt,
      });
    } catch (e) { return toolError(e); }
  },

  get_application: async (args) => {
    const { applicationId, userId, role } = args as { applicationId?: string; userId: string; role: string };
    try {
      let appId = applicationId;
      if (!appId && userId) {
        const apps = await prisma.kycApplication.findMany({
          where:   { userId },
          orderBy: { createdAt: 'desc' },
          take:    1,
          select:  { id: true },
        });
        appId = apps[0]?.id;
      }
      if (!appId) return { content: [{ type: 'text', text: JSON.stringify({ error: 'No application found' }) }], isError: true };
      return text(await getApplication(appId, userId, role ?? 'APPLICANT'));
    } catch (e) { return toolError(e); }
  },

  get_document: async (args) => {
    const { documentId, userId, role } = args as { documentId: string; userId: string; role: string };
    try {
      const doc = await prisma.document.findUnique({
        where:   { id: documentId },
        include: {
          extractedFields:      true,
          documentVerification: true,
          application:          { select: { userId: true } },
        },
      });
      if (!doc) throw new AppError(404, 'Document not found');
      if (role === 'APPLICANT' && doc.application.userId !== userId) {
        throw new AppError(403, 'Access denied');
      }
      return text(doc);
    } catch (e) { return toolError(e); }
  },

  cancel_application: async (args) => {
    const { userId, applicationId } = args as { userId: string; applicationId: string };
    try {
      return text(await cancelApplication(userId, applicationId));
    } catch (e) { return toolError(e); }
  },
};

// ── Tool definitions — single source of truth for name/description/schema ────
// Shared by the MCP server below and the LLM tool registry (llm.registry.ts).

export const KYC_TOOL_DEFS: Record<string, { description: string; schema: Record<string, z.ZodTypeAny> }> = {
  create_application: {
    description: 'Create a new DRAFT KYC application for a user. Fails with 409 if the user already has an active (DRAFT/SUBMITTED/PROCESSING/PENDING_REVIEW) application.',
    schema: { userId: z.string() },
  },
  get_upload_params: {
    description: 'Generate signed Cloudinary upload parameters for a document kind on a DRAFT application. The caller uploads directly to Cloudinary using these params, then calls register_document with the returned publicId and secureUrl.',
    schema: {
      applicationId: z.string(),
      userId:        z.string(),
      documentKind:  DocKindEnum,
    },
  },
  register_document: {
    description: 'Register an already-uploaded Cloudinary document against a DRAFT application. publicId is the Cloudinary public_id; secureUrl is the full res.cloudinary.com delivery URL; sha256 is the 64-char lowercase hex digest of the original file. Re-registering the same kind replaces the previous upload.',
    schema: {
      applicationId: z.string(),
      userId:        z.string(),
      documentKind:  DocKindEnum,
      publicId:      z.string().min(1),
      secureUrl:     z.string().url().regex(/^https:\/\/res\.cloudinary\.com\//),
      sha256:        z.string().regex(/^[a-f0-9]{64}$/),
    },
  },
  submit_application: {
    description: 'Submit a DRAFT application (validates, DRAFT → SUBMITTED) and enqueue the AI verification pipeline asynchronously. Returns immediately with { applicationId, status: "PROCESSING" } — poll get_application_status to track progress.',
    schema: {
      applicationId: z.string(),
      userId:        z.string(),
    },
  },
  get_application_status: {
    description: "Lightweight status poll for a submitted application. Returns { id, status, overallScore, scoreBand, submittedAt, updatedAt }. Poll this after submit_application until status is PENDING_REVIEW. If applicationId is omitted, looks up the user's most recent application automatically.",
    schema: {
      applicationId: z.string().optional(),
      userId:        z.string(),
      role:          z.string().optional(),
    },
  },
  get_application: {
    description: "Fetch the full application record including documents (with AI verification results) and the latest review decision. APPLICANTs can only access their own; REVIEWER and ADMIN can access any. If applicationId is omitted, looks up the user's most recent application automatically.",
    schema: {
      applicationId: z.string().optional(),
      userId:        z.string(),
      role:          z.string().optional(),
    },
  },
  get_document: {
    description: 'Fetch a single document with its extracted fields and AI verification results. APPLICANTs can only access documents from their own application; REVIEWER and ADMIN can access any.',
    schema: {
      documentId: z.string(),
      userId:     z.string(),
      role:       z.string(),
    },
  },
  cancel_application: {
    description: 'Supersede a REJECTED application so the user can re-apply. Only REJECTED applications can be cancelled — DRAFT/SUBMITTED/PROCESSING will return 400.',
    schema: {
      userId:        z.string(),
      applicationId: z.string(),
    },
  },
};

// ── MCP server — delegates to kycTools so each handler is reachable directly ───

export const kycAgent = new McpServer({ name: 'kyc-agent', version: '1.0.0' });

for (const [name, def] of Object.entries(KYC_TOOL_DEFS)) {
  kycAgent.tool(name, def.description, def.schema, (args) => kycTools[name]!(args));
}
