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
    const { applicationId, userId, role } = args as { applicationId: string; userId: string; role: string };
    try {
      const app = await getApplication(applicationId, userId, role);
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
    const { applicationId, userId, role } = args as { applicationId: string; userId: string; role: string };
    try {
      return text(await getApplication(applicationId, userId, role));
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

// ── MCP server — delegates to kycTools so each handler is reachable directly ───

export const kycAgent = new McpServer({ name: 'kyc-agent', version: '1.0.0' });

kycAgent.tool(
  'create_application',
  'Create a new DRAFT KYC application for a user. Fails with 409 if the user already has an active (DRAFT/SUBMITTED/PROCESSING/PENDING_REVIEW) application.',
  {
    userId: z.string(),
  },
  (args) => kycTools.create_application(args),
);

kycAgent.tool(
  'get_upload_params',
  'Generate signed Cloudinary upload parameters for a document kind on a DRAFT application. The caller uploads directly to Cloudinary using these params, then calls register_document with the returned publicId and secureUrl.',
  {
    applicationId: z.string(),
    userId:        z.string(),
    documentKind:  DocKindEnum,
  },
  (args) => kycTools.get_upload_params(args),
);

kycAgent.tool(
  'register_document',
  'Register an already-uploaded Cloudinary document against a DRAFT application. publicId is the Cloudinary public_id; secureUrl is the full res.cloudinary.com delivery URL; sha256 is the 64-char lowercase hex digest of the original file. Re-registering the same kind replaces the previous upload.',
  {
    applicationId: z.string(),
    userId:        z.string(),
    documentKind:  DocKindEnum,
    publicId:      z.string().min(1),
    secureUrl:     z.string().url().regex(/^https:\/\/res\.cloudinary\.com\//),
    sha256:        z.string().regex(/^[a-f0-9]{64}$/),
  },
  (args) => kycTools.register_document(args),
);

kycAgent.tool(
  'submit_application',
  'Submit a DRAFT application (validates, DRAFT → SUBMITTED) and enqueue the AI verification pipeline asynchronously. Returns immediately with { applicationId, status: "PROCESSING" } — poll get_application_status to track progress.',
  {
    applicationId: z.string(),
    userId:        z.string(),
  },
  (args) => kycTools.submit_application(args),
);

kycAgent.tool(
  'get_application_status',
  'Lightweight status poll for a submitted application. Returns { id, status, overallScore, scoreBand, submittedAt, updatedAt }. Poll this after submit_application until status is PENDING_REVIEW.',
  {
    applicationId: z.string(),
    userId:        z.string(),
    role:          z.string(),
  },
  (args) => kycTools.get_application_status(args),
);

kycAgent.tool(
  'get_application',
  'Fetch the full application record including documents (with AI verification results) and the latest review decision. APPLICANTs can only access their own; REVIEWER and ADMIN can access any.',
  {
    applicationId: z.string(),
    userId:        z.string(),
    role:          z.string(),
  },
  (args) => kycTools.get_application(args),
);

kycAgent.tool(
  'get_document',
  'Fetch a single document with its extracted fields and AI verification results. APPLICANTs can only access documents from their own application; REVIEWER and ADMIN can access any.',
  {
    documentId: z.string(),
    userId:     z.string(),
    role:       z.string(),
  },
  (args) => kycTools.get_document(args),
);

kycAgent.tool(
  'cancel_application',
  'Supersede a REJECTED application so the user can re-apply. Only REJECTED applications can be cancelled — DRAFT/SUBMITTED/PROCESSING will return 400.',
  {
    userId:        z.string(),
    applicationId: z.string(),
  },
  (args) => kycTools.cancel_application(args),
);
