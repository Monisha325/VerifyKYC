import { v2 as cloudinary } from 'cloudinary';
import { AppStatus, DocKind, DocStatus } from '@prisma/client';
import { prisma } from '../../utils/prisma';
import { audit } from '../../utils/audit';
import { AppError } from '../../middleware/errorHandler';
import type { UploadParamsDto, RegisterDocumentDto, ReplaceDocumentDto } from './document.schema';

const LOW_SCORE_THRESHOLDS: Record<string, number> = {
  AADHAAR:  55,
  PAN:      50,
  PASSPORT: 65,
  DL:       50,
  SELFIE:   45,
  DEFAULT:  55,
};

// One document per kind, five kinds total → hard cap of 5 per application.
const MAX_DOCS_PER_APP = Object.values(DocKind).length;

// Cloudinary's `allowed_formats` takes format/extension tokens (not MIME types).
// `pdf` is included as a safety allowance — the frontend always converts PDFs
// to JPEG before upload, so this only guards against a converted-file bypass.
const ALLOWED_FORMATS = 'jpg,jpeg,png,webp,pdf';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure:     true,
});

// ── Shared guard ──────────────────────────────────────────────────────────────

async function assertOwnerAndDraft(applicationId: string, userId: string) {
  const app = await prisma.kycApplication.findUnique({
    where:  { id: applicationId },
    select: { id: true, userId: true, status: true },
  });
  if (!app) throw new AppError(404, 'Application not found');
  if (app.userId !== userId) throw new AppError(403, 'Access denied');
  if (app.status !== AppStatus.DRAFT) {
    throw new AppError(409, `Cannot modify documents: application is ${app.status}`);
  }
  return app;
}

// ── Generate signed upload parameters ────────────────────────────────────────

export async function generateUploadParams(
  applicationId: string,
  userId: string,
  dto: UploadParamsDto,
) {
  await assertOwnerAndDraft(applicationId, userId);

  // Note: a doc of this kind may already be registered — that's fine, signing
  // params is harmless (no DB write).  registerDocument() below replaces the
  // existing draft upload of the same kind when one is found.

  const timestamp     = Math.round(Date.now() / 1000);
  const folder        = `verikyc/${applicationId}/${dto.kind.toLowerCase()}`;
  const tags          = `verikyc,${dto.kind.toLowerCase()}`;

  // Only the params included here are covered by the signature.
  // The browser MUST send them verbatim; Cloudinary rejects any mismatch.
  const paramsToSign: Record<string, string | number> = {
    allowed_formats: ALLOWED_FORMATS,
    folder,
    tags,
    timestamp,
  };

  // ── Diagnostic: verify secret is real + log exact signed string ───────────
  const _secret = process.env.CLOUDINARY_API_SECRET ?? '';
  const _signedString = Object.keys(paramsToSign).sort()
    .map(k => `${k}=${paramsToSign[k]}`).join('&');
  console.log(
    `[cloudinary-sign] secret: len=${_secret.length}` +
    ` first=${_secret.slice(0, 2)} last=${_secret.slice(-2)}` +
    ` placeholder=${_secret.includes('paste') || _secret.length < 10}`,
  );
  console.log(`[cloudinary-sign] string_to_sign: "${_signedString}"`);
  console.log(`[cloudinary-sign] browser will send (excl file/api_key/signature): allowed_formats, folder, tags, timestamp`);
  // ── End diagnostic ─────────────────────────────────────────────────────────

  const signature = cloudinary.utils.api_sign_request(
    paramsToSign,
    process.env.CLOUDINARY_API_SECRET!,
  );

  return {
    uploadUrl:      `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload`,
    cloudName:      process.env.CLOUDINARY_CLOUD_NAME!,
    apiKey:         process.env.CLOUDINARY_API_KEY!,
    timestamp,
    signature,
    folder,
    allowedFormats: ALLOWED_FORMATS,
    tags,
  };
}

// ── Generate signed upload parameters for a replacement ──────────────────────
// Skips the DRAFT check — the application is actionable (SUBMITTED / PENDING_REVIEW)
// but the document being replaced is FAILED.

export async function generateReplaceUploadParams(
  applicationId: string,
  userId: string,
  docId: string,
) {
  const app = await prisma.kycApplication.findUnique({
    where:  { id: applicationId },
    select: { id: true, userId: true, status: true },
  });
  if (!app) throw new AppError(404, 'Application not found');
  if (app.userId !== userId) throw new AppError(403, 'Access denied');
  if (app.status !== AppStatus.SUBMITTED && app.status !== AppStatus.PENDING_REVIEW && app.status !== AppStatus.PROCESSING) {
    throw new AppError(400, 'Document replacement is only allowed while the application is actionable', 'INVALID_STATUS', {
      status: app.status,
    });
  }

  const doc = await prisma.document.findFirst({
    where:  { id: docId, applicationId },
    select: {
      id: true, kind: true, status: true,
      documentVerification: { select: { rawAiResponse: true } },
    },
  });
  if (!doc) throw new AppError(404, 'Document not found');

  // Low-score VERIFIED docs may also be replaced — gives the user a path to a
  // better score without waiting for a hard FAILED outcome.
  const docRaw             = doc.documentVerification?.rawAiResponse as Record<string, unknown> | null;
  const docConfidence      = typeof docRaw?.doc_confidence === 'number' ? docRaw.doc_confidence : null;
  const threshold          = LOW_SCORE_THRESHOLDS[doc.kind] ?? LOW_SCORE_THRESHOLDS['DEFAULT'];
  const isLowScoreVerified = doc.status === DocStatus.VERIFIED && (docConfidence ?? 100) < threshold;

  if (doc.status !== DocStatus.FAILED && !isLowScoreVerified) {
    throw new AppError(400, 'Only failed or low-score documents can be replaced', 'INVALID_STATUS', {
      status: doc.status,
    });
  }

  const timestamp  = Math.round(Date.now() / 1000);
  const folder     = `verikyc/${applicationId}/${doc.kind.toLowerCase()}`;
  const tags       = `verikyc,${doc.kind.toLowerCase()}`;

  const paramsToSign: Record<string, string | number> = {
    allowed_formats: ALLOWED_FORMATS,
    folder,
    tags,
    timestamp,
  };

  const signature = cloudinary.utils.api_sign_request(
    paramsToSign,
    process.env.CLOUDINARY_API_SECRET!,
  );

  return {
    uploadUrl:      `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload`,
    cloudName:      process.env.CLOUDINARY_CLOUD_NAME!,
    apiKey:         process.env.CLOUDINARY_API_KEY!,
    timestamp,
    signature,
    folder,
    allowedFormats: ALLOWED_FORMATS,
    tags,
  };
}

// ── Register an already-uploaded document ────────────────────────────────────

export async function registerDocument(
  applicationId: string,
  userId: string,
  dto: RegisterDocumentDto,
) {
  await assertOwnerAndDraft(applicationId, userId);

  // One document per kind — re-registering a kind that's already present
  // replaces it (the wizard's "Replace" action re-runs this same flow with a
  // freshly-picked file).  A DRAFT application's documents are always UPLOADED
  // (the pipeline never runs before submission), so the existing row is safe
  // to supersede outright.
  const existingKind = await prisma.document.findFirst({
    where:  { applicationId, kind: dto.kind },
    select: { id: true },
  });

  // Hard cap: one of each kind — only meaningful when filling a brand-new slot.
  if (!existingKind) {
    const count = await prisma.document.count({ where: { applicationId } });
    if (count >= MAX_DOCS_PER_APP) {
      throw new AppError(422, `Maximum of ${MAX_DOCS_PER_APP} documents allowed per application`);
    }
  }

  // Duplicate content detection within this application — exclude the doc being replaced.
  const dupHash = await prisma.document.findFirst({
    where: {
      applicationId,
      sha256: dto.sha256,
      ...(existingKind ? { id: { not: existingKind.id } } : {}),
    },
    select: { id: true, kind: true },
  });
  if (dupHash) {
    throw new AppError(409, 'A document with identical file content is already registered for this application');
  }

  const doc = await prisma.document.create({
    data: {
      applicationId,
      kind:          dto.kind,
      cloudinaryId:  dto.publicId,
      cloudinaryUrl: dto.secureUrl,
      sha256:        dto.sha256,
      uploadedAt:    new Date(),
    },
    select: {
      id:            true,
      kind:          true,
      status:        true,
      cloudinaryId:  true,
      cloudinaryUrl: true,
      sha256:        true,
      uploadedAt:    true,
    },
  });

  if (existingKind) {
    await audit({
      action:        'DOCUMENT_REPLACED',
      entity:        'Document',
      entityId:      doc.id,
      actorId:       userId,
      applicationId,
      meta:          { docKind: dto.kind, oldDocId: existingKind.id, newDocId: doc.id },
    });
    // Hard-delete the superseded draft upload (cascade removes related rows)
    await prisma.document.delete({ where: { id: existingKind.id } });
  } else {
    await audit({
      action:        'DOC_REGISTERED',
      entity:        'Document',
      entityId:      doc.id,
      actorId:       userId,
      applicationId,
      meta:          { kind: dto.kind, publicId: dto.publicId },
    });
  }

  return doc;
}

// ── Replace a failed document with a new upload ───────────────────────────────

export async function replaceFailedDocument(
  userId: string,
  appId: string,
  docId: string,
  dto: ReplaceDocumentDto,
) {
  // Ownership + status guard
  const app = await prisma.kycApplication.findFirst({
    where:  { id: appId, userId },
    select: { id: true, status: true },
  });
  if (!app) throw new AppError(404, 'Application not found');
  if (app.status !== AppStatus.SUBMITTED && app.status !== AppStatus.PENDING_REVIEW && app.status !== AppStatus.PROCESSING) {
    throw new AppError(400, 'Document replacement is only allowed while the application is actionable', 'INVALID_STATUS', {
      status: app.status,
    });
  }

  // Validate the document being replaced
  const oldDoc = await prisma.document.findFirst({
    where:  { id: docId, applicationId: appId },
    select: {
      id: true, kind: true, status: true,
      documentVerification: { select: { rawAiResponse: true } },
    },
  });
  if (!oldDoc) throw new AppError(404, 'Document not found');

  // Low-score VERIFIED docs may also be replaced — gives the user a path to a
  // better score without waiting for a hard FAILED outcome.
  const oldDocRaw          = oldDoc.documentVerification?.rawAiResponse as Record<string, unknown> | null;
  const oldDocConfidence   = typeof oldDocRaw?.doc_confidence === 'number' ? oldDocRaw.doc_confidence : null;
  const threshold          = LOW_SCORE_THRESHOLDS[oldDoc.kind] ?? LOW_SCORE_THRESHOLDS['DEFAULT'];
  const isLowScoreVerified = oldDoc.status === DocStatus.VERIFIED && (oldDocConfidence ?? 100) < threshold;

  if (oldDoc.status !== DocStatus.FAILED && !isLowScoreVerified) {
    throw new AppError(400, 'Only failed or low-score documents can be replaced', 'INVALID_STATUS', {
      status: oldDoc.status,
    });
  }

  // Duplicate content check — exclude the document being replaced
  const dupHash = await prisma.document.findFirst({
    where:  { applicationId: appId, sha256: dto.sha256, id: { not: docId } },
    select: { id: true },
  });
  if (dupHash) {
    throw new AppError(409, 'A document with identical file content is already registered for this application');
  }

  // Create the replacement document row
  const newDoc = await prisma.document.create({
    data: {
      applicationId: appId,
      kind:          oldDoc.kind,
      cloudinaryId:  dto.publicId,
      cloudinaryUrl: dto.secureUrl,
      sha256:        dto.sha256,
      uploadedAt:    new Date(),
    },
    select: {
      id:            true,
      kind:          true,
      status:        true,
      cloudinaryId:  true,
      cloudinaryUrl: true,
      sha256:        true,
      uploadedAt:    true,
    },
  });

  // Audit event written before deleting the old row so the trail exists
  await audit({
    action:        'DOCUMENT_REPLACED',
    entity:        'Document',
    entityId:      newDoc.id,
    actorId:       userId,
    applicationId: appId,
    meta:          {
      docKind:   oldDoc.kind,
      oldDocId:  docId,
      newDocId:  newDoc.id,
      reason:    isLowScoreVerified ? 're-upload-low-score' : 're-upload-failed',
      threshold: isLowScoreVerified ? threshold : null,
    },
  });

  // Hard-delete the superseded FAILED document (cascade removes related rows)
  await prisma.document.delete({ where: { id: docId } });

  return newDoc;
}
