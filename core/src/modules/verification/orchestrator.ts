/**
 * In-process async worker.
 *
 * enqueueApplication() is called via setImmediate from the submit controller
 * so the HTTP 202 is flushed before processing begins.
 *
 * Robustness:
 *   - If this process crashes mid-pipeline, the application stays in PROCESSING
 *     and documents stay in PROCESSING/QUEUED.  On restart, the caller may
 *     re-enqueue by calling enqueueApplication() again.  Each stage is
 *     idempotent, so re-runs are safe.
 *   - Per-document errors are caught and logged; remaining documents
 *     continue processing.
 */

import { AppStatus, DocStatus } from '@prisma/client';
import { prisma, withRetry }   from '../../utils/prisma';
import { audit }               from '../../utils/audit';
import { transition }          from '../applications/application.service';
import { runDocumentPipeline } from './pipeline';
import { runIdentityCorrelation } from './identity.correlation';
import { finalize }               from './scoring';

export function enqueueApplication(applicationId: string): void {
  _processApplication(applicationId).catch((err: unknown) => {
    console.error(`[orchestrator] processApplication(${applicationId}) uncaught:`, err);
  });
}

// ── Single-document re-processing (used after document replacement) ───────────
// Runs the pipeline for one document, then re-runs identity correlation and
// recomputes the overall score.  Does NOT change application status.

export function enqueueSingleDocument(applicationId: string, documentId: string): void {
  _processSingleDocument(applicationId, documentId).catch((err: unknown) => {
    console.error(`[orchestrator] processSingleDocument(${applicationId}, ${documentId}) uncaught:`, err);
  });
}

async function _processSingleDocument(applicationId: string, documentId: string): Promise<void> {
  try {
    try {
      await runDocumentPipeline(documentId);
      console.log(`[orchestrator] single document ${documentId} complete`);
    } catch (err: unknown) {
      console.error(`[orchestrator] single document ${documentId} pipeline failed:`, err);
    }

    let identityResult;
    try {
      identityResult = await withRetry(() => runIdentityCorrelation(applicationId));
    } catch (err: unknown) {
      console.error(`[orchestrator] identity correlation failed for ${applicationId}:`, err);
      // Create a fail-safe identity result so scoring can still run
      identityResult = {
        nameMatch:     0,
        dobMatch:      false,
        genderMatch:   false,
        addressMatch:  0,
        faceMatch:     0,
        identityScore: 0,
        hardFails:     ['identity_correlation_error'],
        faceDetails:   [],
      };
    }

    try {
      await withRetry(() => finalize(applicationId, identityResult));
    } catch (err: unknown) {
      console.error(`[orchestrator] scoring failed for ${applicationId}:`, err);
    }

    console.log(`[orchestrator] application ${applicationId} re-scored after document ${documentId} replacement`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[orchestrator] FATAL error for app ${applicationId} doc ${documentId}: ${msg}`);
    try {
      await audit({
        action:        'PIPELINE_ERROR',
        entity:        'KycApplication',
        entityId:      applicationId,
        applicationId,
        actorId:       undefined,
        meta:          { error: msg, documentId },
      });
    } catch { /* best-effort — do not throw if audit also fails */ }
  }
}

// ── Top-level safety net + timeout ────────────────────────────────────────────
// Catches any unhandled error from _runPipeline (including timeouts) and
// ensures the application ALWAYS transitions to PENDING_REVIEW — never stays
// stuck in PROCESSING.

// 3 docs × (30+180+30+30+60+30+60) = 3 × 420s = 1260s pipeline
// + identity correlation: 2 govt IDs × 3 attempts × 120s = 720s
// + buffer: 120s
// Total: 2100s = 35 minutes
const PIPELINE_TIMEOUT_MS = 35 * 60 * 1000; // 35 minutes

async function _processApplication(applicationId: string): Promise<void> {
  try {
    await Promise.race([
      _runPipeline(applicationId),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Pipeline timeout after ${PIPELINE_TIMEOUT_MS / 60_000} minutes`)), PIPELINE_TIMEOUT_MS)
      ),
    ]);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = msg.includes('timeout');
    console.error(`[orchestrator] FATAL error for app ${applicationId}: ${msg}`);
    try {
      await audit({
        action:        isTimeout ? 'PIPELINE_TIMEOUT' : 'PIPELINE_ERROR',
        entity:        'KycApplication',
        entityId:      applicationId,
        applicationId,
        actorId:       undefined,
        meta:          { error: msg },
      });
      // Force transition so the application is never permanently stuck in PROCESSING
      await prisma.kycApplication.update({
        where: { id: applicationId },
        data:  { status: AppStatus.PENDING_REVIEW },
      });
      if (isTimeout) {
        console.log(`[orchestrator] safety net fired for app ${applicationId} — pipeline continues in background, score will update shortly`);
      }
    } catch (cleanupErr: unknown) {
      console.error(`[orchestrator] cleanup after FATAL error failed for ${applicationId}:`, cleanupErr);
    }
  }
}

async function _runPipeline(applicationId: string): Promise<void> {
  const app = await prisma.kycApplication.findUnique({
    where:   { id: applicationId },
    include: { documents: { select: { id: true, status: true } } },
  });

  if (!app) {
    console.error(`[orchestrator] application ${applicationId} not found`);
    return;
  }

  // Accept SUBMITTED (fresh submit) or PROCESSING (crash-restart resume).
  if (app.status !== AppStatus.SUBMITTED && app.status !== AppStatus.PROCESSING) {
    console.warn(
      `[orchestrator] application ${applicationId} is ${app.status}, expected SUBMITTED or PROCESSING — skipping`,
    );
    return;
  }

  // SUBMITTED → PROCESSING: transition before doing any work so that a crash
  // mid-pipeline leaves the application in PROCESSING, not SUBMITTED.
  if (app.status === AppStatus.SUBMITTED) {
    await transition(applicationId, AppStatus.PROCESSING);
  }

  // Only process documents that haven't reached a terminal state.
  // NEEDS_REVIEW is terminal for the pipeline — it routes to manual review queue.
  const pending = app.documents.filter(
    (d) => d.status !== DocStatus.VERIFIED &&
           d.status !== DocStatus.FAILED   &&
           d.status !== DocStatus.NEEDS_REVIEW,
  );

  console.log(
    `[orchestrator] processing application ${applicationId} — ${pending.length}/${app.documents.length} documents pending`,
  );

  await Promise.all(
    pending.map(async (doc) => {
      try {
        await runDocumentPipeline(doc.id);
        console.log(`[orchestrator] document ${doc.id} complete`);
      } catch (err: unknown) {
        console.error(`[orchestrator] document ${doc.id} pipeline failed:`, err);
        // Continue with remaining documents — one bad document must not block others
      }
    })
  );

  // ── Identity Correlation ──────────────────────────────────────────────────
  //   Cross-document name/DOB/gender/address comparison + face verification.
  //   Persists IdentityCorrelation row; emits IDENTITY_CORRELATED audit event.

  let identityResult;
  try {
    identityResult = await runIdentityCorrelation(applicationId);
  } catch (err: unknown) {
    console.error(`[orchestrator] identity correlation failed for ${applicationId}:`, err);
    // Create a fail-safe identity result so scoring can still run
    identityResult = {
      nameMatch:     0,
      dobMatch:      false,
      genderMatch:   false,
      addressMatch:  0,
      faceMatch:     0,
      identityScore: 0,
      hardFails:     ['identity_correlation_error'],
      faceDetails:   [],
    };
  }
  console.log(`[orchestrator] identity result: ${JSON.stringify(identityResult)}`);

  // ── Overall Scoring ───────────────────────────────────────────────────────
  //   Blends doc-confidence mean with identity score, applies guardrail caps,
  //   assigns recommendation band, persists on application.
  //   Emits AUTO_SCORED audit event.

  try {
    await finalize(applicationId, identityResult);
  } catch (err: unknown) {
    console.error(`[orchestrator] scoring failed for ${applicationId}:`, err);
  }
  console.log(`[orchestrator] finalize completed for app ${applicationId}`);

  await audit({
    action:        'ORCHESTRATOR_COMPLETE',
    entity:        'KycApplication',
    entityId:      applicationId,
    applicationId,
    actorId:       undefined,
    meta: {
      totalDocs:    app.documents.length,
      pendingRan:   pending.length,
    },
  });

  // Orchestrator MUST NOT mutate application status directly.
  // It delegates to the Applications module's transition() so that all
  // business rules and audit logging live in one place.
  await transition(applicationId, AppStatus.PENDING_REVIEW);

  console.log(`[orchestrator] application ${applicationId} → PENDING_REVIEW`);
}

