import { AppStatus, DocStatus } from '@prisma/client';
import { prisma } from '../../utils/prisma';
import { audit } from '../../utils/audit';
import { AppError } from '../../middleware/errorHandler';

// ── Create ────────────────────────────────────────────────────────────────────

export async function createApplication(userId: string) {
  // Guard: block only while an application is in-flight; REJECTED and APPROVED allow re-apply
  const existing = await prisma.kycApplication.findFirst({
    where:   { userId, status: { in: [AppStatus.DRAFT, AppStatus.SUBMITTED, AppStatus.PROCESSING, AppStatus.PENDING_REVIEW] } },
    select:  { id: true, status: true },
    orderBy: { createdAt: 'desc' },
  });

  if (existing) {
    throw new AppError(409, 'You already have an active application.', 'APPLICATION_EXISTS', {
      applicationId: existing.id,
      status:        existing.status,
    });
  }

  const app = await prisma.kycApplication.create({
    data: { userId },
    select: { id: true, status: true, createdAt: true },
  });
  await audit({
    action: 'APP_CREATED',
    entity: 'KycApplication',
    entityId: app.id,
    actorId: userId,
    applicationId: app.id,
  });
  return app;
}

// ── Submit ────────────────────────────────────────────────────────────────────
// Returns the updated application.  The controller fires enqueueApplication
// via setImmediate after the 202 is sent — no circular dep between modules.

export async function submitApplication(applicationId: string, userId: string) {
  const app = await prisma.kycApplication.findUnique({
    where: { id: applicationId },
    include: { documents: { select: { id: true } } },
  });
  if (!app) throw new AppError(404, 'Application not found');
  if (app.userId !== userId) throw new AppError(403, 'Access denied');
  if (app.status !== AppStatus.DRAFT) {
    throw new AppError(409, `Cannot submit: application is already ${app.status}`);
  }
  if (app.documents.length === 0) {
    throw new AppError(422, 'Add at least one document before submitting');
  }

  // Atomic: DRAFT → SUBMITTED + set submittedAt + queue all uploaded docs.
  // The orchestrator transitions SUBMITTED → PROCESSING when the worker picks it up.
  await prisma.$transaction([
    prisma.kycApplication.update({
      where: { id: applicationId },
      data: { status: AppStatus.SUBMITTED, submittedAt: new Date() },
    }),
    prisma.document.updateMany({
      where: { applicationId, status: DocStatus.UPLOADED },
      data: { status: DocStatus.QUEUED },
    }),
  ]);

  await audit({
    action: 'APP_SUBMITTED',
    entity: 'KycApplication',
    entityId: applicationId,
    actorId: userId,
    applicationId,
    meta: { documentCount: app.documents.length },
  });

  return { id: applicationId, status: AppStatus.SUBMITTED };
}

// ── List (caller's own applications) ─────────────────────────────────────────

export async function listApplications(userId: string) {
  return prisma.kycApplication.findMany({
    where:   { userId },
    orderBy: { createdAt: 'desc' },
    include: {
      documents: {
        select: {
          id: true, kind: true, status: true,
          cloudinaryUrl: true, uploadedAt: true, updatedAt: true,
          documentVerification: {
            select: { ocrConfidence: true, isAuthentic: true, fraudScore: true, rawAiResponse: true, verifiedAt: true },
          },
        },
      },
      // Latest decision for the applicant-facing status page (reason codes only — no reviewer notes)
      reviewDecisions: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { decision: true, reasonCodes: true, decidedAt: true },
      },
    },
  });
}

// ── Get ───────────────────────────────────────────────────────────────────────

export async function getApplication(applicationId: string, userId: string, role: string) {
  const app = await prisma.kycApplication.findUnique({
    where: { id: applicationId },
    include: {
      documents: {
        select: {
          id: true,
          kind: true,
          status: true,
          cloudinaryUrl: true,
          uploadedAt: true,
          updatedAt: true,
          documentVerification: {
            select: { ocrConfidence: true, isAuthentic: true, fraudScore: true, rawAiResponse: true, verifiedAt: true },
          },
        },
      },
      // Latest decision — applicants see decision + reason codes but NOT reviewer notes
      reviewDecisions: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { decision: true, reasonCodes: true, decidedAt: true },
      },
    },
  });
  if (!app) throw new AppError(404, 'Application not found');

  // Owners can see their own; REVIEWER/ADMIN can see any
  if (role === 'APPLICANT' && app.userId !== userId) throw new AppError(403, 'Access denied');
  return app;
}

// ── Cancel (supersede a rejected application to allow re-apply) ──────────────

export async function cancelApplication(userId: string, appId: string) {
  const app = await prisma.kycApplication.findFirst({
    where:  { id: appId, userId },
    select: { id: true, status: true },
  });
  if (!app) throw new AppError(404, 'Application not found');
  if (app.status !== AppStatus.REJECTED) {
    throw new AppError(400, 'Only rejected applications can be superseded', 'INVALID_STATUS', {
      status: app.status,
    });
  }
  await audit({
    action:        'APPLICATION_SUPERSEDED',
    entity:        'KycApplication',
    entityId:      appId,
    actorId:       userId,
    applicationId: appId,
    meta:          { reason: 're-apply' },
  });
  return { success: true };
}

// ── Transition (exported for use by the Orchestrator) ─────────────────────────

export async function transition(
  applicationId: string,
  newStatus: AppStatus,
  actorId?: string,
) {
  await prisma.kycApplication.update({
    where: { id: applicationId },
    data: {
      status: newStatus,
      ...(newStatus === AppStatus.APPROVED || newStatus === AppStatus.REJECTED
        ? { completedAt: new Date() }
        : {}),
    },
  });
  await audit({
    action: 'APP_STATUS_CHANGED',
    entity: 'KycApplication',
    entityId: applicationId,
    actorId,
    applicationId,
    meta: { newStatus },
  });
}
