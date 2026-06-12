/**
 * Cross-document identity correlation.
 *
 * Runs AFTER all documents in an application have completed the per-document
 * pipeline.  Compares extracted fields across documents and calls the AI
 * service for face verification (selfie vs each govt-ID photo).
 *
 * Fail-safe policy (per CLAUDE.md + user directive):
 *   Face verification unavailable → faceMatch = 0, flag raised, guardrail
 *   caps fire, application routes to PENDING_REVIEW flagged.  Never fabricate
 *   a neutral or passing score.
 */

import { DocKind, Prisma }              from '@prisma/client';
import * as fuzz                         from 'fuzzball';
import { prisma, withRetry }             from '../../utils/prisma';
import { audit }                         from '../../utils/audit';
import { verifyFaceProfile }             from './ai.client';

// ── Address abbreviation expansions ───────────────────────────────────────────

const ADDRESS_ABBREVIATIONS: Record<string, string> = {
  'ST':    'STREET',
  'RD':    'ROAD',
  'AVE':   'AVENUE',
  'BLVD':  'BOULEVARD',
  'DR':    'DRIVE',
  'LN':    'LANE',
  'CT':    'COURT',
  'PL':    'PLACE',
  'SQ':    'SQUARE',
  'APT':   'APARTMENT',
  'BLDG':  'BUILDING',
  'FLR':   'FLOOR',
  'STE':   'SUITE',
  'HWY':   'HIGHWAY',
  'PKY':   'PARKWAY',
  'DIST':  'DISTRICT',
  'NAGAR': 'NAGAR',
  'VLG':   'VILLAGE',
  'PO':    'POST OFFICE',
};

// ── Normalisers ───────────────────────────────────────────────────────────────

function normaliseName(raw: string): string {
  return raw.toUpperCase().trim().replace(/\s+/g, ' ');
}

function normaliseGender(raw: string): string | null {
  const s = raw.trim().toUpperCase();
  if (s === 'M' || s === 'MALE')   return 'M';
  if (s === 'F' || s === 'FEMALE') return 'F';
  return null;
}

/**
 * Parse a DOB string to ISO (YYYY-MM-DD).
 * Handles DD/MM/YYYY, DD-MM-YYYY, YYMMDD (MRZ), and bare YYYY.
 */
function parseDobToIso(raw: string): string | null {
  const s = raw.trim();
  // DD/MM/YYYY or DD-MM-YYYY
  const m1 = s.match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})$/);
  if (m1) return `${m1[3]}-${m1[2]}-${m1[1]}`;
  // YYMMDD (MRZ)
  const m2 = s.match(/^(\d{2})(\d{2})(\d{2})$/);
  if (m2) {
    const yy = +m2[1];
    const yyyy = yy <= 24 ? 2000 + yy : 1900 + yy;
    return `${yyyy}-${m2[2].padStart(2, '0')}-${m2[3].padStart(2, '0')}`;
  }
  // Bare YYYY
  const m3 = s.match(/^(\d{4})$/);
  if (m3) return `${m3[1]}-01-01`;
  return null;
}

function normaliseAddress(raw: string): string {
  let addr = raw.toUpperCase().trim().replace(/\s+/g, ' ');
  // Expand abbreviations
  for (const [abbr, full] of Object.entries(ADDRESS_ABBREVIATIONS)) {
    addr = addr.replace(new RegExp(`\\b${abbr}\\b`, 'g'), full);
  }
  // Remove punctuation
  addr = addr.replace(/[.,;:]/g, ' ').replace(/\s+/g, ' ').trim();
  return addr;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface IdentitySubMatches {
  nameMatch:     number;      // 0..1
  dobMatch:      boolean;
  genderMatch:   boolean;
  addressMatch:  number;      // 0..1
  faceMatch:     number;      // 0..1  (0 when unavailable)
  identityScore: number;      // 0..100
  hardFails:     string[];    // machine-readable flags
  faceDetails:   { docId: string; similarity: number }[];
}

// ── Weights ───────────────────────────────────────────────────────────────────

const W_NAME    = 0.25;
const W_DOB     = 0.20;
const W_GENDER  = 0.05;
const W_ADDRESS = 0.15;
const W_FACE    = 0.35;

const FACE_FLOOR  = 0.3;    // below this → hard cap on identity_score
const DOB_MISMATCH_CAP = 50; // identity_score cap when DOB disagrees across govt IDs
const FACE_FLOOR_CAP   = 30; // identity_score cap when faceMatch < FACE_FLOOR

// ── Main entry point ──────────────────────────────────────────────────────────

async function _runIdentityCorrelationCore(applicationId: string): Promise<IdentitySubMatches> {
  // 1. Load all documents + extracted fields
  const docs = await prisma.document.findMany({
    where:   { applicationId },
    include: { extractedFields: true },
  });

  const selfie  = docs.find(d => d.kind === DocKind.SELFIE);
  const govtIds = docs.filter(d => d.kind !== DocKind.SELFIE);

  // Build per-document field maps
  type FieldMap = Record<string, string>;
  const fieldMaps: { docId: string; kind: DocKind; fields: FieldMap }[] = govtIds.map(d => ({
    docId:  d.id,
    kind:   d.kind,
    fields: Object.fromEntries(d.extractedFields.map(f => [f.fieldName, f.fieldValue])),
  }));

  const hardFails: string[] = [];

  // ── 2. Name matching ────────────────────────────────────────────────────────
  let nameMatch = 1.0;
  const names = fieldMaps.map(fm => fm.fields['name']).filter(Boolean) as string[];
  if (names.length >= 2) {
    const scores: number[] = [];
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const a = normaliseName(names[i]);
        const b = normaliseName(names[j]);
        scores.push(fuzz.token_sort_ratio(a, b) / 100);
      }
    }
    nameMatch = Math.min(...scores);
  } else if (names.length === 1) {
    nameMatch = 1.0;   // only one doc has a name — nothing to compare across docs
  } else {
    nameMatch = 0;     // no name extracted at all — honest 0, but N/A for single-doc scoring (renormalized below)
  }

  // ── 3. DOB matching ─────────────────────────────────────────────────────────
  let dobMatch = true;
  const dobs = fieldMaps
    .map(fm => ({ docId: fm.docId, iso: parseDobToIso(fm.fields['dob'] ?? '') }))
    .filter(d => d.iso !== null) as { docId: string; iso: string }[];

  if (dobs.length >= 2) {
    const first = dobs[0].iso;
    dobMatch = dobs.every(d => d.iso === first);
    if (!dobMatch) hardFails.push('dob_mismatch_across_govt_ids');
  } else if (dobs.length === 0) {
    dobMatch = false;   // no DOB extracted — honest false; N/A for single-doc scoring (renormalized below)
  }
  // dobs.length === 1: only one doc has a DOB — dobMatch stays true (nothing to compare against)

  // ── 4. Gender matching ──────────────────────────────────────────────────────
  let genderMatch = true;
  const genders = fieldMaps
    .map(fm => normaliseGender(fm.fields['gender'] ?? ''))
    .filter(g => g !== null) as string[];

  if (genders.length >= 2) {
    genderMatch = genders.every(g => g === genders[0]);
  } else if (genders.length === 0) {
    genderMatch = true;   // gender is low-weight; don't penalise if missing
  }

  // ── 5. Address matching ─────────────────────────────────────────────────────
  let addressMatch = 1.0;
  const addresses = fieldMaps.map(fm => fm.fields['address']).filter(Boolean) as string[];
  if (addresses.length >= 2) {
    const scores: number[] = [];
    for (let i = 0; i < addresses.length; i++) {
      for (let j = i + 1; j < addresses.length; j++) {
        const a = normaliseAddress(addresses[i]);
        const b = normaliseAddress(addresses[j]);
        scores.push(fuzz.token_set_ratio(a, b) / 100);
      }
    }
    addressMatch = Math.min(...scores);
  } else if (addresses.length <= 1) {
    // Only one or zero docs have an address — can't meaningfully compare.
    // Neutral: don't penalise, but don't award full marks either.
    addressMatch = addresses.length === 1 ? 0.5 : 0;
  }

  // ── 6. Face matching ────────────────────────────────────────────────────────
  let faceMatch = 0;
  let faceReason: string | null = null;
  const faceDetails: { docId: string; similarity: number }[] = [];

  if (selfie?.cloudinaryUrl && govtIds.length > 0) {
    const govtWithImages = govtIds.filter(d => d.cloudinaryUrl);

    if (govtWithImages.length === 0) {
      hardFails.push('no_govt_id_images');
    } else {
      // Single call: ArcFace embedding for selfie + each document, cosine similarity,
      // discrete band scoring (>=0.85→100, 0.70-0.84→75, 0.50-0.69→40, <0.50→0),
      // final faceMatch = average of per-document scores (normalized to 0..1).
      const docUrls    = govtWithImages.map(d => d.cloudinaryUrl!);
      const docUrlToId = new Map(govtWithImages.map(d => [d.cloudinaryUrl!, d.id]));
      const faceCallStart = Date.now();
      console.log('[FACE CALL START]', {
        selfieUrl:  selfie.cloudinaryUrl.slice(0, 80),
        docUrls:    docUrls.map(u => u.slice(0, 80)),
        docCount:   docUrls.length,
        timestamp:  new Date().toISOString(),
      });
      try {
        const result = await verifyFaceProfile(selfie.cloudinaryUrl, docUrls);
        const faceCallMs = Date.now() - faceCallStart;

        if (result.flag) {
          console.error('[FACE CALL FLAG]', {
            flag:      result.flag,
            reason:    result.reason ?? null,
            elapsedMs: faceCallMs,
            timestamp: new Date().toISOString(),
          });
          hardFails.push('face_verification_unavailable');
          if (result.reason) faceReason = result.reason;
        } else {
          for (const ds of result.scores) {
            const docId = docUrlToId.get(ds.doc_url) ?? 'unknown';
            faceDetails.push({ docId, similarity: ds.score / 100 });
          }

          // Average of discrete per-document scores → normalized 0..1
          faceMatch = result.profile_verification_pct / 100;

          console.log('[FACE CALL SUCCESS]', {
            profile_verification_pct: result.profile_verification_pct,
            faceMatch,
            scores:    result.scores.map(s => ({ cosine: s.cosine_sim.toFixed(3), score: s.score })),
            elapsedMs: faceCallMs,
            timestamp: new Date().toISOString(),
          });
        }
      } catch (err: unknown) {
        const faceCallMs = Date.now() - faceCallStart;
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[FACE CALL FAILED]', {
          message:   msg,
          elapsedMs: faceCallMs,
          isTimeout: msg.includes('abort') || msg.includes('timeout') || msg.includes('ECONNABORTED'),
          timestamp: new Date().toISOString(),
        });
        hardFails.push('face_verification_unavailable');
        await audit({
          action:        'FACE_VERIFICATION_UNAVAILABLE',
          entity:        'KycApplication',
          entityId:      applicationId,
          applicationId,
          meta: {
            reason:        'ai_service_unavailable_after_retries',
            docsAttempted: govtWithImages.length,
            elapsedMs:     faceCallMs,
            error:         msg,
            faceDetails,
          },
        });
      }
    }
  } else {
    if (!selfie) hardFails.push('no_selfie_document');
    if (govtIds.length === 0) hardFails.push('no_govt_id_documents');
  }

  // Face below floor → hard fail.  Always fires when faceMatch < FACE_FLOOR,
  // including when the AI service was unavailable (fail-safe: outage ≠ pass).
  if (faceMatch < FACE_FLOOR) {
    hardFails.push('face_below_floor');
  }

  // ── 7. Identity score (renormalized) ────────────────────────────────────────
  // Each cross-document attribute is included in the weighted sum only when
  // ≥2 documents have a comparable value for that field.
  //
  //   • Single-doc application: none of the cross-compare fields reach ≥2 →
  //     identity score is driven entirely by face match.
  //   • Two docs, both have name: compare them normally.
  //   • Two docs, only one has a name extracted: N/A (nothing to compare against;
  //     do NOT award nameMatch=1.0 for free — exclude from the denominator).
  //   • Two docs, neither has a name extracted: N/A (field_completeness in the
  //     per-document pipeline already penalises the missing field).
  //
  // Face is always included because it drives the fail-safe caps below.
  const scoredAttrs: { w: number; v: number }[] = [
    ...(names.length     >= 2 ? [{ w: W_NAME,    v: nameMatch }]           : []),
    ...(dobs.length      >= 2 ? [{ w: W_DOB,     v: dobMatch ? 1 : 0 }]   : []),
    ...(genders.length   >= 2 ? [{ w: W_GENDER,  v: genderMatch ? 1 : 0 }]: []),
    ...(addresses.length >= 2 ? [{ w: W_ADDRESS, v: addressMatch }]        : []),
    { w: W_FACE, v: faceMatch },
  ];
  const totalWeight = scoredAttrs.reduce((s, a) => s + a.w, 0);
  let identityScore = Math.round(
    scoredAttrs.reduce((s, a) => s + a.w * a.v, 0) / totalWeight * 100,
  );

  // Hard-fail caps
  if (hardFails.includes('dob_mismatch_across_govt_ids')) {
    identityScore = Math.min(identityScore, DOB_MISMATCH_CAP);
  }
  if (hardFails.includes('face_below_floor') || hardFails.includes('face_verification_unavailable')) {
    identityScore = Math.min(identityScore, FACE_FLOOR_CAP);
  }

  // ── 7b. Soft flags — informational only, never cap the score ────────────────
  const softFlags: string[] = [];
  if (faceMatch >= 0.35 && faceMatch < 0.60) {
    softFlags.push('face_requires_manual_review');
    console.log('[CORRELATION] Borderline face match — flagged for manual review', {
      faceMatch,
      range: '35–60%',
    });
  }

  // ── 8. Persist IdentityCorrelation ──────────────────────────────────────────

  const subMatches: IdentitySubMatches = {
    nameMatch,
    dobMatch,
    genderMatch,
    addressMatch,
    faceMatch,
    identityScore,
    hardFails,
    faceDetails,
  };

  const correlationData = {
    faceMatchScore:    faceMatch,
    nameMatchScore:    nameMatch,
    dobMatchScore:     dobMatch ? 1.0 : 0.0,
    genderMatchScore:  genderMatch ? 1.0 : 0.0,
    addressMatchScore: addressMatch,
    overallScore:      identityScore,
    isCorrelated:      identityScore >= 55 && hardFails.length === 0,
    rawAiResponse:  {
      nameMatch,
      dobMatch,
      genderMatch,
      addressMatch,
      faceMatch,
      faceReason,
      faceDetails,
      hardFails,
      softFlags,
      identityScore,
      fieldCounts: {
        names: names.length,
        dobs: dobs.length,
        genders: genders.length,
        addresses: addresses.length,
      },
      names:     names.map(normaliseName),
      dobs:      dobs.map(d => d.iso),
      genders,
      addresses: addresses.map(normaliseAddress),
    } as Prisma.InputJsonValue,
    correlatedAt: new Date(),
  };

  await withRetry(() => prisma.identityCorrelation.upsert({
    where:  { applicationId },
    create: { applicationId, ...correlationData },
    update: correlationData,
  }));

  // ── 9. Audit ────────────────────────────────────────────────────────────────

  await audit({
    action:        'IDENTITY_CORRELATED',
    entity:        'KycApplication',
    entityId:      applicationId,
    applicationId,
    meta: {
      identityScore,
      nameMatch,
      dobMatch,
      genderMatch,
      addressMatch,
      faceMatch,
      hardFails,
    },
  });

  console.log(
    `[identity-correlation] application ${applicationId} → identityScore=${identityScore}, ` +
    `hardFails=[${hardFails.join(',')}]`,
  );

  return subMatches;
}

// ── Exported entry point with null-safety wrapper ─────────────────────────────
// Any unhandled error inside the correlation logic returns the fail-safe result
// so the orchestrator can always proceed to scoring.

export async function runIdentityCorrelation(applicationId: string): Promise<IdentitySubMatches> {
  try {
    return await _runIdentityCorrelationCore(applicationId);
  } catch (err: unknown) {
    console.error(
      `[identity-correlation] failed for application ${applicationId}:`,
      err instanceof Error ? err.message : err,
    );
    return {
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
}
