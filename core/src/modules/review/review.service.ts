import { v2 as cloudinary } from 'cloudinary';
import { AppStatus, Decision } from '@prisma/client';
import { prisma }              from '../../utils/prisma';
import { audit, auditOperation } from '../../utils/audit';
import { AppError }            from '../../middleware/errorHandler';
import { transition }          from '../applications/application.service';
import type { DecisionDto }    from './review.schema';

// ── Cloudinary ────────────────────────────────────────────────────────────────

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure:     true,
});

// 5-minute expiry for evidence-bundle delivery URLs.
// NOTE: For true access restriction, documents must be uploaded with
// type:'authenticated' in Cloudinary so the original URL also requires a
// signature.  The signed URLs here expire in 5 min regardless.
const SIGNED_URL_TTL = 300;

function signedDeliveryUrl(cloudinaryId: string | null): string | null {
  if (!cloudinaryId) return null;
  return cloudinary.url(cloudinaryId, {
    sign_url:      true,
    type:          'upload',
    expires_at:    Math.round(Date.now() / 1000) + SIGNED_URL_TTL,
    secure:        true,
    resource_type: 'image',
  });
}

// ── Flag labels ───────────────────────────────────────────────────────────────

const FLAG_LABELS: Record<string, string> = {
  checksum_fail:                 'ID checksum invalid',
  mrz_fail:                      'Machine-readable zone failed ICAO verification',
  paste_detected:                'Suspected image paste or compositing',
  duplicate_image:               'Same image used for multiple documents',
  type_mismatch:                 'Declared document type does not match AI-detected type',
  metadata_edited:               'Document metadata appears to have been edited',
  noise_inconsistent:            'Copy-move artefacts detected',
  impossible_date:               'Document contains an implausible date',
  future_dob:                    'Date of birth is in the future',
  low_ocr_conf:                  'Low OCR confidence — text may be obscured',
  minor_template_offset:         'Minor template misalignment detected',
  face_below_floor:              'Face similarity below minimum acceptance threshold',
  face_verification_unavailable: 'Face verification service unavailable during processing',
  dob_mismatch_across_govt_ids:  'Date of birth mismatch across government IDs',
  no_selfie_document:            'No selfie document was uploaded',
  no_govt_id_documents:          'No government ID documents were uploaded',
  blur_fail:                     'Image is too blurry to read',
  glare_fail:                    'Glare detected on document surface',
  resolution_fail:               'Image resolution is too low',
  ocr_error:                     'OCR processing encountered an error',
  quality_check_error:           'Image quality check failed',
  qr_missing_aadhaar:            'Aadhaar QR code not detected — may indicate a non-genuine document',
};

function labelFlags(flags: string[]): Array<{ code: string; label: string }> {
  return flags.map(f => ({ code: f, label: FLAG_LABELS[f] ?? f }));
}

function bandToRecommendation(band: string | null): string {
  if (band === 'FAST_TRACK') return 'Approve — all checks passed with high confidence';
  if (band === 'STANDARD')   return 'Likely approve — standard review recommended';
  if (band === 'FLAGGED')    return 'Do not approve — requires detailed fraud investigation';
  return 'Insufficient data — manual review required';
}

// ── Queue ─────────────────────────────────────────────────────────────────────

export async function getQueue() {
  const apps = await prisma.kycApplication.findMany({
    where:  { status: AppStatus.PENDING_REVIEW },
    select: {
      id:           true,
      status:       true,
      overallScore: true,
      scoreBand:    true,
      submittedAt:  true,
      createdAt:    true,
      claimedById:  true,
      claimedAt:    true,
      user:         { select: { id: true, fullName: true, email: true } },
      documents: {
        select: {
          documentVerification: { select: { rawAiResponse: true } },
        },
      },
    },
  });

  // Compute per-application flag count from document rawAiResponse.flags
  const appsWithFlagCount = apps.map(app => {
    let flagCount = 0;
    for (const doc of app.documents) {
      const raw = doc.documentVerification?.rawAiResponse as Record<string, unknown> | null;
      if (raw?.flags && Array.isArray(raw.flags)) {
        flagCount += (raw.flags as string[]).length;
      }
    }
    const { documents: _docs, ...rest } = app;
    void _docs;
    return { ...rest, flagCount };
  });

  // FLAGGED band first, then highest flag count, then newest within each tier.
  appsWithFlagCount.sort((a, b) => {
    const aFlagged = a.scoreBand === 'FLAGGED' ? 0 : 1;
    const bFlagged = b.scoreBand === 'FLAGGED' ? 0 : 1;
    if (aFlagged !== bFlagged) return aFlagged - bFlagged;
    if (b.flagCount !== a.flagCount) return b.flagCount - a.flagCount;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });

  return appsWithFlagCount;
}

// ── Evidence bundle ───────────────────────────────────────────────────────────

export async function getEvidenceBundle(applicationId: string) {
  const app = await prisma.kycApplication.findUnique({
    where:   { id: applicationId },
    include: {
      user:               { select: { id: true, fullName: true, email: true } },
      documents:          { include: { extractedFields: true, documentVerification: true } },
      identityCorrelation: true,
      reviewDecisions:    { orderBy: { createdAt: 'desc' } },
    },
  });
  if (!app) throw new AppError(404, 'Application not found');
  if (app.status !== AppStatus.PENDING_REVIEW) {
    throw new AppError(409, `Application is not in PENDING_REVIEW (current: ${app.status})`);
  }

  const documents = app.documents.map(doc => {
    const raw    = doc.documentVerification?.rawAiResponse as Record<string, unknown> | null;
    const flags  = (raw?.flags  as string[]                  | undefined) ?? [];
    const signals = (raw?.signals as Record<string, unknown> | undefined) ?? {};
    const authSig = signals.authenticity as Record<string, unknown> | undefined;

    return {
      id:         doc.id,
      kind:       doc.kind,
      status:     doc.status,
      signedUrl:  signedDeliveryUrl(doc.cloudinaryId),   // short-lived; never the raw public URL
      uploadedAt: doc.uploadedAt,
      extractedFields: doc.extractedFields.map(f => ({
        fieldName:  f.fieldName,
        fieldValue: f.fieldValue,
        confidence: f.confidence,
        source:     f.source,
      })),
      docConfidence: typeof raw?.doc_confidence === 'number' ? raw.doc_confidence : null,
      authenticity: {
        isAuthentic:    doc.documentVerification?.isAuthentic   ?? null,
        ocrConfidence:  doc.documentVerification?.ocrConfidence ?? null,
        score:          authSig?.score ?? null,
        method:         authSig?.method ?? null,
      },
      fraud: {
        score:      doc.documentVerification?.fraudScore ?? null,
        firedFlags: labelFlags(flags),
      },
    };
  });

  const ic    = app.identityCorrelation;
  const icRaw = ic?.rawAiResponse as Record<string, unknown> | null;
  const identityCorrelation = ic ? {
    nameMatchScore:  ic.nameMatchScore,
    dobMatchScore:   ic.dobMatchScore,
    faceMatchScore:  ic.faceMatchScore,
    overallScore:    ic.overallScore,
    isCorrelated:    ic.isCorrelated,
    subMatches: {
      name:    icRaw?.nameMatch,
      dob:     icRaw?.dobMatch,
      gender:  icRaw?.genderMatch,
      address: icRaw?.addressMatch,
      face:    icRaw?.faceMatch,
    },
    hardFails:   labelFlags((icRaw?.hardFails as string[] | undefined) ?? []),
    softFlags:   (icRaw?.softFlags as string[] | undefined) ?? [],
    faceDetails: icRaw?.faceDetails ?? [],
    faceReason:  (icRaw?.faceReason as string | null | undefined) ?? null,
  } : null;

  return {
    id:                app.id,
    status:            app.status,
    overallScore:      app.overallScore,
    scoreBand:         app.scoreBand,
    autoRecommendation: bandToRecommendation(app.scoreBand),
    claimedById:       app.claimedById,
    claimedAt:         app.claimedAt,
    submittedAt:       app.submittedAt,
    applicant:         app.user,
    documents,
    identityCorrelation,
    priorDecisions:    app.reviewDecisions,
  };
}

// ── Claim ─────────────────────────────────────────────────────────────────────

export async function claimApplication(applicationId: string, reviewerId: string) {
  const app = await prisma.kycApplication.findUnique({
    where:  { id: applicationId },
    select: { status: true, claimedById: true },
  });
  if (!app) throw new AppError(404, 'Application not found');
  if (app.status !== AppStatus.PENDING_REVIEW) {
    throw new AppError(409, `Application is not in PENDING_REVIEW (current: ${app.status})`);
  }
  // Idempotent re-claim by the same reviewer
  if (app.claimedById === reviewerId) {
    return { applicationId, claimedById: reviewerId, message: 'Already claimed by you' };
  }
  if (app.claimedById && app.claimedById !== reviewerId) {
    throw new AppError(409, 'Application is already claimed by another reviewer');
  }

  const claimedAt = new Date();
  await prisma.$transaction([
    prisma.kycApplication.update({
      where: { id: applicationId },
      data:  { claimedById: reviewerId, claimedAt },
    }),
    auditOperation({
      action:        'APP_CLAIMED',
      entity:        'KycApplication',
      entityId:      applicationId,
      actorId:       reviewerId,
      applicationId,
      meta:          { reviewerId },
    }),
  ]);

  return { applicationId, claimedById: reviewerId, claimedAt };
}

// ── Decision ──────────────────────────────────────────────────────────────────

export async function recordDecision(
  applicationId: string,
  reviewerId:    string,
  reviewerRole:  string,
  dto:           DecisionDto,
) {
  const app = await prisma.kycApplication.findUnique({
    where:  { id: applicationId },
    select: { status: true, claimedById: true },
  });
  if (!app) throw new AppError(404, 'Application not found');
  if (app.status !== AppStatus.PENDING_REVIEW) {
    throw new AppError(409, `Cannot decide: application is ${app.status}`);
  }

  // ADMIN can decide without claiming; REVIEWERs must have claimed first.
  if (reviewerRole !== 'ADMIN') {
    if (!app.claimedById) {
      throw new AppError(403, 'Claim the application before recording a decision');
    }
    if (app.claimedById !== reviewerId) {
      throw new AppError(403, 'Application is claimed by another reviewer');
    }
  }

  const decidedAt = new Date();

  // ReviewDecision row + AuditEvent written atomically in a single transaction.
  await prisma.$transaction([
    prisma.reviewDecision.create({
      data: {
        applicationId,
        reviewerId,
        decision:    dto.decision,
        reasonCodes: dto.reasonCodes,
        notes:       dto.notes ?? null,
        decidedAt,
      },
    }),
    auditOperation({
      action:        'REVIEW_DECIDED',
      entity:        'KycApplication',
      entityId:      applicationId,
      actorId:       reviewerId,
      applicationId,
      meta: {
        decision:    dto.decision,
        reasonCodes: dto.reasonCodes,
        notes:       dto.notes,
      },
    }),
  ]);

  // Status transitions after the atomic write.
  if (dto.decision === Decision.APPROVED) {
    await transition(applicationId, AppStatus.APPROVED, reviewerId);
  } else if (dto.decision === Decision.REJECTED) {
    await transition(applicationId, AppStatus.REJECTED, reviewerId);
  } else {
    // ESCALATED — stays PENDING_REVIEW; release claim so a senior reviewer can pick it up.
    await prisma.kycApplication.update({
      where: { id: applicationId },
      data:  { claimedById: null, claimedAt: null },
    });
    await audit({
      action:        'APP_ESCALATED',
      entity:        'KycApplication',
      entityId:      applicationId,
      actorId:       reviewerId,
      applicationId,
      meta:          { reasonCodes: dto.reasonCodes, notes: dto.notes },
    });
  }

  return { applicationId, decision: dto.decision, decidedAt };
}
