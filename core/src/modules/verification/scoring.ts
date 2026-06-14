/**
 * Overall application scoring + band assignment.
 *
 * Runs AFTER runIdentityCorrelation() has persisted its results.
 * Computes the final overall score, applies guardrail caps, assigns a
 * recommendation band, and persists on the application row.
 *
 * IMPORTANT: Nothing auto-approves.  Every application transitions to
 * PENDING_REVIEW regardless of score — the band is only a hint for the
 * human reviewer.
 */

import { AppStatus, Prisma }                 from '@prisma/client';
import { prisma, withRetry }                 from '../../utils/prisma';
import { audit }                             from '../../utils/audit';
import type { IdentitySubMatches }           from './identity.correlation';

// ── Band definitions ──────────────────────────────────────────────────────────

export type ScoreBand = 'FAST_TRACK' | 'STANDARD' | 'FLAGGED';

// ── Hard fraud flags (from pipeline stage 6 fraud signal table) ───────────────

const HARD_FRAUD_FLAGS = new Set([
  'checksum_fail',
  'mrz_fail',
  'paste_detected',
  'duplicate_image',
  'multiple_faces',
]);

// ── Main entry point ──────────────────────────────────────────────────────────

async function _finalizeCore(
  applicationId: string,
  identityResult: IdentitySubMatches,
): Promise<{ overallScore: number; band: ScoreBand }> {

  // 1. Gather per-document confidence scores
  const docs = await prisma.document.findMany({
    where:   { applicationId },
    include: { documentVerification: { select: { rawAiResponse: true, fraudScore: true } } },
  });

  const docConfidences: number[] = [];
  const idDocConfidences: number[] = [];   // govt ID docs only (excludes SELFIE)
  let selfieDocConf: number | null = null; // selfie score = face match %
  let hasHardFraudFlag = false;
  let hasNeedsReview   = false;
  let hasFailedDoc     = false;

  for (const doc of docs) {
    // Selfie FAILED status is re-evaluated by Phase 2 (face-match overwrite) below.
    // Counting it here would set hasFailedDoc before Phase 2 can clear a stale flag,
    // causing cap-at-40 to fire on re-scores even when the new face match passes.
    if (doc.status === 'FAILED' && doc.kind !== 'SELFIE') hasFailedDoc = true;

    console.log('[SCORING DOC STATUS]', {
      docId:         doc.id,
      docKind:       doc.kind,
      docStatus:     doc.status,
      isFailedDoc:   doc.status === 'FAILED' && doc.kind !== 'SELFIE',
      flags:         (doc.documentVerification?.rawAiResponse as Record<string, unknown> | null)?.flags ?? [],
      docConfidence: (doc.documentVerification?.rawAiResponse as Record<string, unknown> | null)?.doc_confidence ?? null,
    });

    const raw = doc.documentVerification?.rawAiResponse as Record<string, unknown> | null;

    // Documents without cryptographic verification block FAST_TRACK.
    if (raw && typeof raw === 'object' &&
        (raw['verification_path'] === 'FALLBACK' || raw['verification_path'] === 'UNVERIFIED')) {
      hasNeedsReview = true;
    }

    if (raw && typeof raw === 'object') {
      const rawConf = 'doc_confidence' in raw ? (raw.doc_confidence as number) : 0;

      if (doc.kind === 'SELFIE') {
        const faceMatchConf = Math.round(identityResult.faceMatch * 100);
        // Only overwrite the pipeline liveness confidence when the face-match AI
        // actually ran and returned a real measurement.  When the AI service was
        // unavailable the result is artificially 0 (not a quality signal), so
        // we preserve the original liveness score to avoid showing a misleading
        // "0 • Verified" on the dashboard.
        const faceWasUnavailable =
          identityResult.hardFails.includes('face_verification_unavailable');

        console.log('[SCORING DEBUG PRE]', {
          faceMatch:             identityResult.faceMatch,
          faceMatchConf,
          faceWasUnavailable,
          selfieConfidenceBefore: rawConf,
          currentFlags:          Array.isArray(raw?.flags) ? raw.flags : [],
          willOverwrite:         !(faceWasUnavailable && faceMatchConf === 0),
          selfieDbStatus:        doc.status,
          hardFails:             identityResult.hardFails,
        });

        if (faceWasUnavailable && faceMatchConf === 0) {
          // AI error — keep the pipeline-assigned liveness confidence
          selfieDocConf = rawConf > 0 ? rawConf : null;
        } else {
          // Real face-match score (may be 0 = genuine mismatch) — use it
          raw.doc_confidence = faceMatchConf;
          selfieDocConf      = faceMatchConf;

          const isFailedMatch = faceMatchConf < 13;
          if (isFailedMatch) {
            const flags = Array.isArray(raw.flags) ? raw.flags : [];
            if (!flags.includes('face_mismatch')) flags.push('face_mismatch');
            raw.flags = flags;
          } else {
            // Clear a stale face_mismatch written by a previous failed run.
            if (Array.isArray(raw.flags)) {
              raw.flags = (raw.flags as string[]).filter(f => f !== 'face_mismatch');
            }
          }

          // Build the status-update fragment.
          // isFailedMatch → mark FAILED.
          // !isFailedMatch but stale FAILED in DB → reset to VERIFIED so the
          // dashboard does not keep showing a red badge after a successful re-score.
          const statusUpdates =
            isFailedMatch
              ? [prisma.document.update({ where: { id: doc.id }, data: { status: 'FAILED'   } })]
              : doc.status === 'FAILED'
              ? [prisma.document.update({ where: { id: doc.id }, data: { status: 'VERIFIED' } })]
              : [];

          await prisma.$transaction([
            prisma.documentVerification.update({
              where: { documentId: doc.id },
              data:  { rawAiResponse: raw as Prisma.InputJsonValue },
            }),
            ...statusUpdates,
          ]);

          if (isFailedMatch) {
            doc.status = 'FAILED';
            hasFailedDoc = true;
          }
        }

        console.log('[SCORING DEBUG POST]', {
          selfieConfidenceAfter: selfieDocConf,
          hasFaceMismatch:       Array.isArray(raw?.flags) && (raw.flags as string[]).includes('face_mismatch'),
          hasFailedDoc,
        });

        // selfie is tracked separately — not added to idDocConfidences
      } else {
        // Government ID document
        idDocConfidences.push(rawConf);
        docConfidences.push(rawConf);
      }

      // Hard fraud flags
      if ('flags' in raw) {
        const flags = raw.flags as string[];
        if (flags.some(f => HARD_FRAUD_FLAGS.has(f))) {
          hasHardFraudFlag = true;
        }
      }
    } else {
      // No verification row — pipeline was never called or crashed.
      // Fail-safe: 0, not neutral 50.
      if (doc.kind !== 'SELFIE') {
        idDocConfidences.push(0);
        docConfidences.push(0);
      }
    }
  }

  // ── Weighted final score: 60% ID docs + 40% face match ─────────────────────
  // meanIdDoc: average over all govt ID documents (Aadhaar, PAN, etc.)
  // faceMatch: 0..1 normalised → 0..100
  const meanIdDocConfidence = idDocConfidences.length > 0
    ? idDocConfidences.reduce((a, b) => a + b, 0) / idDocConfidences.length
    : 0;
  const faceMatchScore = (selfieDocConf !== null)
    ? selfieDocConf                         // already 0..100
    : Math.round(identityResult.faceMatch * 100);

  // For backward-compat with audit / check-scores.ts, keep meanDocConfidence
  const meanDocConfidence = idDocConfidences.length > 0
    ? meanIdDocConfidence
    : 0;

  const identityScore = identityResult.identityScore;

  const faceUnavailable = identityResult.hardFails.includes('face_verification_unavailable');

  // 2. Compute overall score.
  // When face verification was not completed, score on documents alone — no 40% face
  // weight penalty for a step the applicant simply hasn't done yet.
  // When face ran (even a borderline match), use the standard 60/40 weighted formula.
  let overallScore: number;
  if (faceUnavailable) {
    overallScore = Math.round(meanIdDocConfidence);
  } else {
    overallScore = Math.round(0.60 * meanIdDocConfidence + 0.40 * faceMatchScore);
  }

  // 3. Guardrail caps (applied after, not averaged)
  const capsApplied: string[] = [];

  // Fraud cap: only fire when a hard fraud flag was actually detected by the
  // tampering stage — not when the tampering stage itself errored out.
  if (hasHardFraudFlag) {
    const capped = Math.min(overallScore, 40);
    if (capped < overallScore) capsApplied.push('fraud_cap_40');
    overallScore = capped;
  }

  // Failed doc cap: if any document explicitly failed (e.g. signature invalid), cap the overall score
  if (hasFailedDoc) {
    const capped = Math.min(overallScore, 40);
    if (capped < overallScore) capsApplied.push('failed_doc_cap_40');
    overallScore = capped;
  }

  // DOB mismatch cap: only fires when DOB was extracted from multiple docs AND
  // they disagree — never when OCR simply didn't find a DOB.
  if (identityResult.hardFails.includes('dob_mismatch_across_govt_ids')) {
    const capped = Math.min(overallScore, 30);
    if (capped < overallScore) capsApplied.push('dob_cap_30');
    overallScore = capped;
  }

  // NEEDS_REVIEW cap: Re-enabled to ensure the final score correctly reflects
  // that the document requires review (via verification_path: FALLBACK or UNVERIFIED)
  // and does not artificially hit FAST_TRACK.
  if (hasNeedsReview) {
    const capped = Math.min(overallScore, 84);  // just below FAST_TRACK threshold
    if (capped < overallScore) capsApplied.push('needs_review_cap_84');
    overallScore = capped;
  }

  // 4. Band mapping
  let band: ScoreBand;
  // face_verification_unavailable is not a fraud or document-failure signal — it means
  // the applicant still needs to complete profile verification. Excluded from anyHardFlag
  // so a strong doc score can still reach STANDARD, but it always blocks FAST_TRACK.
  const anyHardFlag =
    hasHardFraudFlag ||
    hasFailedDoc ||
    identityResult.hardFails.filter(f => f !== 'face_verification_unavailable').length > 0;

  if (overallScore >= 70 && !anyHardFlag && !hasNeedsReview && !faceUnavailable) {
    band = 'FAST_TRACK';
  } else if (overallScore >= 45 && !anyHardFlag) {
    band = 'STANDARD';
  } else {
    band = 'FLAGGED';
  }

  // 5. Persist overallScore + band + status on the application
  console.log(`[scoring] attempting to write score=${overallScore} band=${band} for app=${applicationId}`);
  try { await prisma.$connect(); } catch (_) {}
  await withRetry(() => prisma.kycApplication.update({
    where: { id: applicationId },
    data: {
      overallScore,
      scoreBand:   band,
      status:      AppStatus.PENDING_REVIEW,
    },
  }));
  console.log(`[scoring] successfully wrote score for app=${applicationId}`);

  // 6. Emit AUTO_SCORED audit event
  await audit({
    action:        'AUTO_SCORED',
    entity:        'KycApplication',
    entityId:      applicationId,
    applicationId,
    meta: {
      overallScore,
      band,
      // Scoring breakdown: 60% ID docs + 40% face match
      meanIdDocConfidence: Math.round(meanIdDocConfidence * 100) / 100,
      faceMatchScore,
      weights: { idDocs: 0.60, faceMatch: 0.40 },
      // Legacy fields kept for backward compat with check-scores.ts
      meanDocConfidence: Math.round(meanDocConfidence * 100) / 100,
      identityScore,
      capsApplied,
      hasHardFraudFlag,
      hasNeedsReview,
      docsScored:       docConfidences.length,
      docConfidences:   [...docConfidences, ...(selfieDocConf !== null ? [selfieDocConf] : [])],
    },
  });

  console.log(
    `[scoring] application ${applicationId} → overall=${overallScore}, band=${band}, ` +
    `caps=[${capsApplied.join(',')}]`,
  );

  return { overallScore, band };
}

// ── Exported entry point with null-safety + emergency fallback ────────────────
// If scoring fails for any reason, attempt a minimal score write.  If that also
// fails, force the application to PENDING_REVIEW so it is never stuck.

export async function finalize(
  applicationId: string,
  identityResult: IdentitySubMatches,
): Promise<{ overallScore: number; band: ScoreBand }> {
  try {
    return await _finalizeCore(applicationId, identityResult);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[scoring] finalize failed for ${applicationId}: ${msg}`);
    try {
      await withRetry(() => prisma.kycApplication.update({
        where: { id: applicationId },
        data:  { overallScore: 0, scoreBand: 'FLAGGED' },
      }));
    } catch (retryErr: unknown) {
      console.error(`[scoring] finalize retry failed for ${applicationId}:`, retryErr);
      // Last resort: at minimum force the status so the application is never stuck
      await prisma.kycApplication.update({
        where: { id: applicationId },
        data:  { status: AppStatus.PENDING_REVIEW },
      }).catch(e => console.error('[scoring] emergency status update failed:', e));
    }
    return { overallScore: 0, band: 'FLAGGED' };
  }
}
