'use client';
import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter }             from 'next/navigation';
import Link                                 from 'next/link';
import {
  AlertTriangle, CheckCircle2, XCircle, Lock, ChevronLeft,
  User, Calendar, FileText, Eye, ShieldAlert, Fingerprint,
  Loader2, ChevronDown, ChevronUp, ExternalLink,
  ScanFace, Check, Minus, X, AlertCircle, Flag,
} from 'lucide-react';
import { api }        from '@/lib/api';
import { useAuth }    from '@/context/AuthContext';
import Badge          from '@/components/ui/Badge';
import Button         from '@/components/ui/Button';
import ScoreGauge     from '@/components/ui/ScoreGauge';
import { PageLoader } from '@/components/ui/LoadingSpinner';
import {
  cn, formatDate, scoreTextColor, scoreBarColor, boostScore, DOC_KIND_LABEL,
} from '@/lib/utils';
import type { EvidenceBundle, ReviewDocument, Decision } from '@/lib/types';

// ── Reason codes (mirror backend review.schema.ts) ────────────────────────────

const REASON_GROUPS = [
  {
    label: 'Approval',
    decision: 'APPROVED' as Decision,
    codes: [
      { code: 'GENUINE_DOCS',        label: 'Genuine documents'       },
      { code: 'IDENTITY_CONFIRMED',  label: 'Identity confirmed'       },
      { code: 'FACE_MATCH_PASSED',   label: 'Face match passed'        },
    ],
  },
  {
    label: 'Rejection',
    decision: 'REJECTED' as Decision,
    codes: [
      { code: 'FRAUD_SUSPECTED',      label: 'Fraud suspected'         },
      { code: 'DOCS_TAMPERED',        label: 'Documents tampered'      },
      { code: 'IDENTITY_MISMATCH',    label: 'Identity mismatch'       },
      { code: 'DUPLICATE_APPLICATION',label: 'Duplicate application'   },
      { code: 'INCOMPLETE_DOCS',      label: 'Incomplete documents'    },
    ],
  },
  {
    label: 'Escalation',
    decision: 'ESCALATED' as Decision,
    codes: [
      { code: 'NEEDS_SENIOR_REVIEW',  label: 'Needs senior review'    },
      { code: 'EDGE_CASE',            label: 'Edge case'               },
      { code: 'POLICY_EXCEPTION',     label: 'Policy exception'        },
    ],
  },
];

// ── Shared helpers ────────────────────────────────────────────────────────────

function BandPill({ band }: { band: string | null }) {
  if (!band) return null;
  const cfg = {
    FLAGGED:    'bg-rose-100 text-rose-700 ring-1 ring-rose-200',
    STANDARD:   'bg-amber-100 text-amber-700 ring-1 ring-amber-200',
    FAST_TRACK: 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200',
  }[band] ?? 'bg-gray-100 text-gray-600';
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs font-bold px-2.5 py-1 rounded-full', cfg)}>
      {band === 'FLAGGED' && <AlertTriangle className="w-3 h-3" />}
      {band.replace('_', ' ')}
    </span>
  );
}

function ScoreBar({ label, value }: { label: string; value: number | null | boolean }) {
  const num = typeof value === 'boolean' ? (value ? 100 : 0) : (value ?? null);
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-gray-500 w-28 flex-shrink-0">{label}</span>
      <div className="flex-1 h-1.5 rounded-full bg-gray-100 overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all', scoreBarColor(num))}
          style={{ width: `${num ?? 0}%` }}
        />
      </div>
      <span className={cn('text-xs font-bold tabular-nums w-10 text-right', scoreTextColor(num))}>
        {num == null ? '—' : typeof value === 'boolean' ? (value ? 'Yes' : 'No') : num.toFixed(0)}
      </span>
    </div>
  );
}

// ── Agreement indicator ───────────────────────────────────────────────────────

type MatchStatus = 'match' | 'mismatch' | 'partial' | 'unavailable';

function MatchIcon({ status }: { status: MatchStatus }) {
  if (status === 'match')       return <Check  className="w-3.5 h-3.5 text-emerald-600" />;
  if (status === 'mismatch')    return <X      className="w-3.5 h-3.5 text-rose-600"    />;
  if (status === 'partial')     return <Minus  className="w-3.5 h-3.5 text-amber-500"   />;
  return                               <Minus  className="w-3.5 h-3.5 text-gray-300"    />;
}

function AgreementRow({
  label, value, matchScore, weight,
}: { label: string; value: string | null; matchScore: number | null; weight: string }) {
  const status: MatchStatus =
    matchScore == null    ? 'unavailable' :
    matchScore >= 0.8     ? 'match'       :
    matchScore >= 0.5     ? 'partial'     : 'mismatch';

  const rowBg =
    status === 'match'    ? 'bg-emerald-50/40' :
    status === 'mismatch' ? 'bg-rose-50/40'    :
    status === 'partial'  ? 'bg-amber-50/40'   : '';

  return (
    <div className={cn('flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs', rowBg)}>
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <MatchIcon status={status} />
      </div>
      <span className="text-gray-500 w-16 flex-shrink-0 font-medium">{label}</span>
      <span className="flex-1 font-semibold text-gray-800 truncate">{value ?? '—'}</span>
      <span className="text-gray-400 text-[10px] flex-shrink-0">{weight}</span>
      {matchScore != null && (
        <span className={cn('text-[10px] font-bold tabular-nums w-8 text-right', scoreTextColor(matchScore * 100))}>
          {(matchScore * 100).toFixed(0)}%
        </span>
      )}
    </div>
  );
}

// ── Document evidence card ────────────────────────────────────────────────────

function DocEvidenceCard({ doc }: { doc: ReviewDocument }) {
  const [imgOpen, setImgOpen] = useState(false);
  const hasFlags = doc.fraud.firedFlags.length > 0;
  void imgOpen; void setImgOpen;

  return (
    <div className={cn(
      'rounded-2xl border overflow-hidden',
      hasFlags ? 'border-rose-200 bg-rose-50/20' : 'border-gray-100 bg-white',
    )}>
      {/* Doc header */}
      <div className={cn(
        'flex items-center justify-between px-4 py-3 border-b',
        hasFlags ? 'border-rose-100 bg-rose-50/40' : 'border-gray-100 bg-gray-50/60',
      )}>
        <div className="flex items-center gap-2">
          <FileText className={cn('w-4 h-4', hasFlags ? 'text-rose-500' : 'text-gray-400')} />
          <span className="text-sm font-semibold text-gray-900 font-mono">
            {DOC_KIND_LABEL[doc.kind]}
          </span>
          {hasFlags && (
            <Badge className="bg-rose-100 text-rose-700 text-[10px]">
              {doc.fraud.firedFlags.length} flag{doc.fraud.firedFlags.length > 1 ? 's' : ''}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-3">
          {/* doc_confidence — the headline per-document score */}
          {doc.docConfidence != null && (() => { const bc = boostScore(doc.docConfidence)!; return (
            <div className="flex items-center gap-1.5">
              <div className="w-20 h-1.5 rounded-full bg-gray-100 overflow-hidden">
                <div
                  className={cn('h-full rounded-full', scoreBarColor(bc))}
                  style={{ width: `${bc}%` }}
                />
              </div>
              <span className={cn('text-xs font-bold tabular-nums', scoreTextColor(bc))}>
                {bc}
              </span>
            </div>
          ); })()}
          <span className="text-gray-200">|</span>
          <span className={cn('text-xs font-bold tabular-nums', scoreTextColor(
            typeof doc.authenticity.score === 'number' ? doc.authenticity.score : null
          ))}>
            Auth {doc.authenticity.score?.toFixed(0) ?? '—'}
          </span>
          <span className="text-gray-300">·</span>
          <span className={cn('text-xs font-bold tabular-nums', scoreTextColor(
            doc.fraud.score != null ? (1 - doc.fraud.score) * 100 : null
          ))}>
            Fraud {doc.fraud.score != null ? (doc.fraud.score * 100).toFixed(0) : '—'}
          </span>
        </div>
      </div>

      {/* Two-column: image | fields */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-0 divide-y md:divide-y-0 md:divide-x divide-gray-100">

        {/* Document image */}
        <div className="p-4">
          {doc.signedUrl ? (
            <div className="relative">
              <div className="rounded-xl overflow-hidden bg-gray-900 aspect-[3/2]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={doc.signedUrl}
                  alt={DOC_KIND_LABEL[doc.kind]}
                  className="w-full h-full object-contain"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
              </div>
              <div className="flex items-center justify-between mt-2 text-xs text-gray-400">
                <span>Signed URL · expires 5 min</span>
                <a href={doc.signedUrl} target="_blank" rel="noreferrer"
                   className="flex items-center gap-1 hover:text-brand-navy transition-colors">
                  <ExternalLink className="w-3 h-3" /> Open
                </a>
              </div>
            </div>
          ) : (
            <div className="rounded-xl bg-gray-100 aspect-[3/2] flex items-center justify-center">
              <Eye className="w-8 h-8 text-gray-300" />
            </div>
          )}
        </div>

        {/* Extracted fields + fraud flags */}
        <div className="p-4 space-y-4">
          {/* Extracted fields */}
          {doc.extractedFields.length > 0 ? (
            <div>
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                Extracted Fields
              </p>
              <div className="space-y-1.5">
                {doc.extractedFields
                  .filter(f => !f.fieldName.startsWith('ocr_segment_'))
                  .map((f, i) => (
                    <div key={i} className="flex items-baseline justify-between gap-3 text-xs">
                      <span className="text-gray-400 capitalize flex-shrink-0">
                        {f.fieldName.replace(/_/g, ' ')}
                      </span>
                      <span className="font-medium text-gray-800 text-right truncate max-w-[160px]">
                        {f.fieldValue}
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          ) : (
            <p className="text-xs text-gray-400">No structured fields extracted.</p>
          )}

          {/* Fraud flags */}
          {hasFlags && (
            <div>
              <p className="text-xs font-semibold text-rose-500 uppercase tracking-wider mb-2">
                Fraud Signals
              </p>
              <div className="space-y-1">
                {doc.fraud.firedFlags.map(flag => (
                  <div key={flag.code}
                    className="flex items-center gap-2 text-xs bg-rose-50 text-rose-700 rounded-lg px-2.5 py-1.5">
                    <AlertTriangle className="w-3 h-3 flex-shrink-0" />
                    {flag.label}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Scores */}
          <div className="pt-2 border-t border-gray-100 space-y-1.5">
            <ScoreBar label="Authenticity"  value={doc.authenticity.score} />
            <ScoreBar label="Fraud score"   value={doc.fraud.score != null ? (1 - doc.fraud.score) * 100 : null} />
            {doc.authenticity.ocrConfidence != null && (
              <ScoreBar label="OCR confidence" value={doc.authenticity.ocrConfidence * 100} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Section C — Face match panel ──────────────────────────────────────────────

function FaceMatchPanel({ bundle }: { bundle: EvidenceBundle }) {
  const ic      = bundle.identityCorrelation;
  const selfie  = bundle.documents.find(d => d.kind === 'SELFIE');
  const govtIds = bundle.documents.filter(d => d.kind !== 'SELFIE' && d.signedUrl);

  const faceScore          = ic?.faceMatchScore ?? null;  // 0..1
  const facePct            = faceScore != null ? Math.round(faceScore * 100) : null;
  const isMatch            = faceScore != null && faceScore >= 0.35;
  const profileNotVerified = ic?.hardFails?.some(f => f.code === 'face_verification_unavailable') ?? false;

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 px-5 py-3.5 border-b border-gray-100 bg-gray-50/60">
        <ScanFace className="w-4 h-4 text-brand-navy" />
        <span className="text-sm font-semibold text-gray-900 font-mono">Face Match</span>
        {faceScore != null && (
          <span className={cn(
            'ml-auto inline-flex items-center gap-1.5 text-xs font-bold px-2.5 py-1 rounded-full',
            isMatch
              ? 'bg-emerald-100 text-emerald-700'
              : 'bg-rose-100 text-rose-700',
          )}>
            {isMatch ? <Check className="w-3 h-3" /> : <X className="w-3 h-3" />}
            {isMatch ? 'MATCH' : 'NO MATCH'}
          </span>
        )}
      </div>

      <div className="p-5 space-y-4">

        {/* Profile verification not completed */}
        {profileNotVerified && (
          <div className="flex items-start gap-3 rounded-xl bg-blue-50 border border-blue-200 px-4 py-3">
            <AlertCircle className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-blue-700">Profile verification not completed</p>
              <p className="text-xs text-blue-600 mt-0.5">
                The applicant has not completed face verification. Score is based on documents only. Manual review required before approval.
              </p>
            </div>
          </div>
        )}

        {/* Face detection failure reason banner */}
        {ic?.faceReason === 'unable_to_detect_face_in_document' && (
          <div className="flex items-start gap-3 rounded-xl bg-amber-50 border border-amber-200 px-4 py-3">
            <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-amber-700">Face not detected in document</p>
              <p className="text-xs text-amber-600 mt-0.5">
                The AI could not locate a face region in the uploaded ID document. Manual review of the document photo is required.
              </p>
            </div>
          </div>
        )}
        {ic?.faceReason === 'unable_to_detect_face_in_any_document' && (
          <div className="flex items-start gap-3 rounded-xl bg-amber-50 border border-amber-200 px-4 py-3">
            <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-amber-700">Face not detected in any document</p>
              <p className="text-xs text-amber-600 mt-0.5">
                No face region was found across all submitted ID documents. Manual review of all document photos is required.
              </p>
            </div>
          </div>
        )}

        {/* Borderline face soft flag */}
        {ic?.softFlags?.includes('face_requires_manual_review') && (
          <div className="flex items-start gap-3 rounded-xl bg-amber-50 border border-amber-200 px-4 py-3">
            <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-amber-700">Borderline face match — manual review recommended</p>
              <p className="text-xs text-amber-600 mt-0.5">
                Face similarity is in the 35–60% range. Score is not capped, but human verification of the photo is advised.
              </p>
            </div>
          </div>
        )}

        {/* Side-by-side image comparison */}
        <div className="grid grid-cols-2 gap-3">
          {/* Selfie */}
          <div>
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2 text-center">
              Selfie
            </p>
            <div className="rounded-xl overflow-hidden bg-gray-900 aspect-square">
              {selfie?.signedUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={selfie.signedUrl}
                  alt="Selfie"
                  className="w-full h-full object-cover"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <Eye className="w-8 h-8 text-gray-600" />
                </div>
              )}
            </div>
          </div>

          {/* Document photo (first govt ID with image) */}
          <div>
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2 text-center">
              Document Photo
            </p>
            <div className="rounded-xl overflow-hidden bg-gray-900 aspect-square">
              {govtIds[0]?.signedUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={govtIds[0].signedUrl}
                  alt="Document photo"
                  className="w-full h-full object-cover"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <Eye className="w-8 h-8 text-gray-600" />
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Match metrics */}
        <div className="grid grid-cols-2 gap-3 text-center">
          <div className="rounded-xl bg-gray-50 px-3 py-2.5">
            <p className={cn('text-xl font-bold tabular-nums font-mono leading-none', scoreTextColor(facePct))}>
              {facePct != null ? `${facePct}%` : '—'}
            </p>
            <p className="text-[10px] text-gray-400 mt-1 font-medium uppercase tracking-wider">
              Face Score
            </p>
          </div>
          <div className="rounded-xl bg-gray-50 px-3 py-2.5">
            <p className="text-xl font-bold tabular-nums font-mono leading-none text-gray-700">
              {ic?.faceDetails[0]
                ? ic.faceDetails[0].similarity.toFixed(3)
                : '—'}
            </p>
            <p className="text-[10px] text-gray-400 mt-1 font-medium uppercase tracking-wider">
              ArcFace Distance
            </p>
          </div>
        </div>

        {/* Per-doc face matches */}
        {ic && ic.faceDetails.length > 1 && (
          <div className="space-y-1.5">
            {ic.faceDetails.map((fd, i) => (
              <ScoreBar key={i} label={`Doc ${i + 1}`} value={fd.similarity * 100} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Section D — Identity correlation panel ────────────────────────────────────

function IdentityPanel({ bundle }: { bundle: EvidenceBundle }) {
  const ic = bundle.identityCorrelation;

  // Collect the best-available extracted value for each field across all docs
  const allFields = bundle.documents.flatMap(d => d.extractedFields);
  function bestField(name: string): string | null {
    const f = allFields.find(f => f.fieldName === name && !f.fieldName.startsWith('ocr_segment_'));
    return f?.fieldValue ?? null;
  }

  const nameVal    = bestField('name');
  const dobVal     = bestField('dob');
  const genderVal  = bestField('gender');
  const addressVal = bestField('address');

  const nameScore    = ic ? (ic.nameMatchScore ?? null)                 : null;
  const dobScore     = ic ? (ic.dobMatchScore ?? null)                  : null;
  const faceScore    = ic ? (ic.faceMatchScore ?? null)                 : null;
  const icRaw        = ic as unknown as { subMatches?: { gender?: number; address?: number } } | null;
  const genderScore  = icRaw?.subMatches?.gender  != null ? icRaw.subMatches.gender  : null;
  const addressScore = icRaw?.subMatches?.address != null ? icRaw.subMatches.address : null;

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 px-5 py-3.5 border-b border-gray-100 bg-gray-50/60">
        <Fingerprint className="w-4 h-4 text-brand-navy" />
        <span className="text-sm font-semibold text-gray-900 font-mono">Identity Correlation</span>
      </div>
      <div className="p-5 space-y-4">

        {/* Overall score with gauge */}
        <div className="flex items-center gap-4 p-3 rounded-xl bg-gray-50">
          <ScoreGauge score={boostScore(bundle.overallScore)} className="w-28 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs text-gray-500 leading-relaxed">{bundle.autoRecommendation}</p>
            {bundle.scoreBand && <BandPill band={bundle.scoreBand} />}
          </div>
        </div>

        {/* Agreement indicators */}
        <div>
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
            Cross-Document Agreement
          </p>
          <div className="space-y-1.5">
            <AgreementRow label="Name"    value={nameVal}    matchScore={nameScore}    weight="25%" />
            <AgreementRow label="DOB"     value={dobVal}     matchScore={dobScore}     weight="20%" />
            <AgreementRow label="Gender"  value={genderVal}  matchScore={genderScore}  weight="5%"  />
            <AgreementRow label="Address" value={addressVal} matchScore={addressScore} weight="15%" />
            <AgreementRow label="Face"    value={faceScore != null ? `${(faceScore * 100).toFixed(0)}%` : null}
                           matchScore={faceScore} weight="35%" />
          </div>
        </div>

        {/* Identity sub-scores */}
        {ic && (
          <div className="pt-2 border-t border-gray-100 space-y-1.5">
            <ScoreBar label="Identity score"  value={boostScore(ic.overallScore)} />
            <ScoreBar label="Face match"      value={ic.faceMatchScore != null ? ic.faceMatchScore * 100 : null} />
            <ScoreBar label="Correlated"      value={ic.isCorrelated} />
          </div>
        )}

        {/* Hard fails */}
        {ic && ic.hardFails.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-rose-500 uppercase tracking-wider mb-2">Hard Fails</p>
            <div className="space-y-1">
              {ic.hardFails.map(f => (
                <div key={f.code}
                  className="flex items-center gap-2 text-xs bg-rose-50 text-rose-700 rounded-lg px-2.5 py-1.5">
                  <ShieldAlert className="w-3 h-3 flex-shrink-0" />
                  {f.label}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Confirmation modal ────────────────────────────────────────────────────────

const DECISION_META: Record<Decision, { label: string; color: string; desc: string }> = {
  APPROVED:  { label: 'Approve',  color: 'bg-emerald-600 text-white hover:bg-emerald-700', desc: 'This will approve the KYC application.' },
  REJECTED:  { label: 'Reject',   color: 'bg-rose-600 text-white hover:bg-rose-700',       desc: 'This will reject the KYC application.'  },
  ESCALATED: { label: 'Escalate', color: 'bg-amber-500 text-white hover:bg-amber-600',     desc: 'This will escalate the application for senior review. It will remain in the queue.' },
};

function ConfirmModal({
  decision,
  reasonCodes,
  onConfirm,
  onCancel,
  loading,
}: {
  decision:    Decision;
  reasonCodes: string[];
  onConfirm:   () => void;
  onCancel:    () => void;
  loading:     boolean;
}) {
  const meta = DECISION_META[decision];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative bg-white rounded-2xl shadow-card-lg w-full max-w-sm p-6 space-y-4 animate-fade-up">
        <div className="flex items-center gap-3">
          {decision === 'APPROVED'  && <CheckCircle2 className="w-6 h-6 text-emerald-600" />}
          {decision === 'REJECTED'  && <XCircle      className="w-6 h-6 text-rose-600"    />}
          {decision === 'ESCALATED' && <AlertTriangle className="w-6 h-6 text-amber-500"  />}
          <h2 className="text-base font-bold text-gray-900 font-mono">Confirm {meta.label}</h2>
        </div>
        <p className="text-sm text-gray-600">{meta.desc}</p>
        <div className="bg-gray-50 rounded-xl px-4 py-3">
          <p className="text-xs text-gray-500 font-semibold uppercase tracking-wider mb-2">Reason codes</p>
          <div className="flex flex-wrap gap-1.5">
            {reasonCodes.map(code => (
              <span key={code} className="text-xs bg-white border border-gray-200 text-gray-700 rounded-lg px-2 py-0.5">
                {code.replace(/_/g, ' ')}
              </span>
            ))}
          </div>
        </div>
        <div className="flex gap-3 pt-1">
          <button
            onClick={onCancel}
            className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className={cn(
              'flex-1 py-2.5 rounded-xl text-sm font-bold transition-colors flex items-center justify-center gap-2',
              'disabled:opacity-60 disabled:cursor-not-allowed',
              meta.color,
            )}
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : meta.label}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Section E — Decision panel ────────────────────────────────────────────────

const DECISION_STYLES: Record<Decision, string> = {
  APPROVED:  'bg-emerald-600 hover:bg-emerald-700 text-white',
  REJECTED:  'bg-rose-600 hover:bg-rose-700 text-white',
  ESCALATED: 'bg-amber-500 hover:bg-amber-600 text-white',
};

function DecisionPanel({
  bundle, currentUserId, onClaim, onDecide, claiming, deciding,
}: {
  bundle:        EvidenceBundle;
  currentUserId: string;
  onClaim:       () => void;
  onDecide:      (decision: Decision, reasonCodes: string[], note: string) => void;
  claiming:      boolean;
  deciding:      boolean;
}) {
  const [selectedCodes,  setSelectedCodes]  = useState<string[]>([]);
  const [note,           setNote]           = useState('');
  const [showNotes,      setShowNotes]      = useState(false);
  const [pendingDecision, setPendingDecision] = useState<Decision | null>(null);

  const claimedByMe    = bundle.claimedById === currentUserId;
  const claimedByOther = !!bundle.claimedById && !claimedByMe;

  function toggleCode(code: string) {
    setSelectedCodes(prev =>
      prev.includes(code) ? prev.filter(c => c !== code) : [...prev, code],
    );
  }

  function handleSubmitDecision() {
    if (!pendingDecision) return;
    onDecide(pendingDecision, selectedCodes, note);
    setPendingDecision(null);
  }

  if (claimedByOther) {
    return (
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="flex items-center gap-2 px-5 py-3.5 border-b border-gray-100 bg-gray-50/60">
          <Lock className="w-4 h-4 text-gray-400" />
          <span className="text-sm font-semibold text-gray-900">Decision</span>
        </div>
        <div className="p-5 text-center space-y-3">
          <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center mx-auto">
            <Lock className="w-6 h-6 text-gray-400" />
          </div>
          <p className="text-sm font-semibold text-gray-700">Claimed by another reviewer</p>
          <p className="text-xs text-gray-400">
            This application is locked. The claiming reviewer must complete the review.
          </p>
        </div>
      </div>
    );
  }

  if (!bundle.claimedById) {
    return (
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="flex items-center gap-2 px-5 py-3.5 border-b border-gray-100 bg-gray-50/60">
          <User className="w-4 h-4 text-brand-navy" />
          <span className="text-sm font-semibold text-gray-900">Decision</span>
        </div>
        <div className="p-5 text-center space-y-4">
          <p className="text-sm text-gray-500">
            Claim this application to lock it to you before reviewing.
          </p>
          <Button onClick={onClaim} loading={claiming} className="w-full">
            Claim &amp; Begin Review
          </Button>
        </div>
      </div>
    );
  }

  // Claimed by me — show decision form
  return (
    <>
      {/* Confirmation modal */}
      {pendingDecision && (
        <ConfirmModal
          decision={pendingDecision}
          reasonCodes={selectedCodes}
          onConfirm={handleSubmitDecision}
          onCancel={() => setPendingDecision(null)}
          loading={deciding}
        />
      )}

      <div className="bg-white rounded-2xl border border-brand-navy/20 shadow-sm overflow-hidden">
        <div className="flex items-center gap-2 px-5 py-3.5 border-b border-brand-navy/10 bg-brand-navy/[0.03]">
          <CheckCircle2 className="w-4 h-4 text-emerald-500" />
          <span className="text-sm font-semibold text-gray-900">Your Decision</span>
          <Badge className="bg-brand-navy/8 text-brand-navy text-[10px] ml-auto">Claimed by you</Badge>
        </div>

        <div className="p-5 space-y-5">
          {/* Reason codes */}
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
              Reason Codes <span className="text-rose-500 ml-0.5">*</span>
            </p>
            <div className="space-y-4">
              {REASON_GROUPS.map(group => (
                <div key={group.label}>
                  <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">
                    {group.label}
                  </p>
                  <div className="space-y-1.5">
                    {group.codes.map(({ code, label }) => {
                      const checked = selectedCodes.includes(code);
                      return (
                        <label key={code}
                          className={cn(
                            'flex items-center gap-2.5 rounded-lg px-3 py-2 cursor-pointer transition-colors text-sm',
                            checked ? 'bg-brand-navy/5 text-brand-navy' : 'hover:bg-gray-50 text-gray-600',
                          )}
                        >
                          <div className={cn(
                            'w-4 h-4 rounded flex-shrink-0 flex items-center justify-center border-2 transition-colors',
                            checked ? 'bg-brand-navy border-brand-navy' : 'border-gray-300',
                          )}>
                            {checked && <Check className="w-3 h-3 text-white" strokeWidth={3} />}
                          </div>
                          <input type="checkbox" className="sr-only"
                            checked={checked} onChange={() => toggleCode(code)} />
                          {label}
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
            {selectedCodes.length === 0 && (
              <p className="text-xs text-rose-500 mt-2">Select at least one reason code</p>
            )}
          </div>

          {/* Optional note */}
          <div>
            <button type="button" onClick={() => setShowNotes(v => !v)}
              className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 transition-colors">
              {showNotes ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              {showNotes ? 'Hide notes' : 'Add optional notes'}
            </button>
            {showNotes && (
              <textarea value={note} onChange={e => setNote(e.target.value)}
                placeholder="Reviewer notes (optional)…" rows={3} maxLength={2000}
                className="mt-2 w-full rounded-xl border border-gray-200 px-3 py-2 text-sm
                           placeholder:text-gray-400 focus:outline-none focus:ring-2
                           focus:ring-brand-navy focus:border-transparent resize-none" />
            )}
          </div>

          {/* Decision buttons */}
          <div className="space-y-2 pt-1">
            {(['APPROVED', 'REJECTED', 'ESCALATED'] as Decision[]).map(d => (
              <button key={d}
                disabled={deciding || selectedCodes.length === 0}
                onClick={() => setPendingDecision(d)}
                className={cn(
                  'w-full py-2.5 rounded-xl text-sm font-bold transition-all',
                  'disabled:opacity-40 disabled:cursor-not-allowed',
                  'flex items-center justify-center gap-2',
                  DECISION_STYLES[d],
                )}
              >
                {d === 'APPROVED'  ? <CheckCircle2  className="w-4 h-4" />
                 : d === 'REJECTED'  ? <XCircle       className="w-4 h-4" />
                 : <AlertTriangle className="w-4 h-4" />}
                {d === 'APPROVED' ? 'Approve' : d === 'REJECTED' ? 'Reject' : 'Escalate'}
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

// ── Main detail page ──────────────────────────────────────────────────────────

export default function ReviewDetailPage() {
  const { id }   = useParams<{ id: string }>();
  const router   = useRouter();
  const { user } = useAuth();

  const [bundle,    setBundle]    = useState<EvidenceBundle | null>(null);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState('');
  const [claiming,  setClaiming]  = useState(false);
  const [deciding,  setDeciding]  = useState(false);
  const [actionErr, setActionErr] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const { data } = await api.get<EvidenceBundle>(`/review/${id}`);
      setBundle(data);
    } catch (e: unknown) {
      setError(
        (e as { response?: { data?: { error?: string } } })?.response?.data?.error
        ?? 'Could not load the evidence bundle.',
      );
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  async function handleClaim() {
    setClaiming(true); setActionErr('');
    try {
      await api.post(`/review/${id}/claim`);
      await load();
    } catch (e: unknown) {
      setActionErr(
        (e as { response?: { data?: { error?: string } } })?.response?.data?.error
        ?? 'Could not claim this application.',
      );
    } finally { setClaiming(false); }
  }

  async function handleDecide(decision: Decision, reasonCodes: string[], notes: string) {
    setDeciding(true); setActionErr('');
    try {
      await api.post(`/review/${id}/decision`, { decision, reasonCodes, notes: notes || undefined });
      router.push('/admin/queue');
    } catch (e: unknown) {
      setActionErr(
        (e as { response?: { data?: { error?: string } } })?.response?.data?.error
        ?? 'Decision could not be recorded.',
      );
      setDeciding(false);
    }
  }

  if (loading) return <PageLoader />;
  if (error) {
    // 409 = application already decided — show a friendly closed state instead of raw error
    const isClosed = error.toLowerCase().includes('pending_review') || error.toLowerCase().includes('rejected') || error.toLowerCase().includes('approved');
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-5 animate-fade-up">
        <div className={cn(
          'w-16 h-16 rounded-2xl flex items-center justify-center',
          isClosed ? 'bg-gray-100' : 'bg-rose-50',
        )}>
          {isClosed
            ? <Lock className="w-8 h-8 text-gray-400" />
            : <AlertCircle className="w-8 h-8 text-rose-400" />}
        </div>
        <div className="text-center space-y-1.5">
          <p className="text-base font-semibold text-gray-800">
            {isClosed ? 'Application already decided' : 'Could not load application'}
          </p>
          <p className="text-sm text-gray-500 max-w-sm">
            {isClosed
              ? 'This application has been closed and is no longer available for review. Use the queue to find open applications.'
              : error}
          </p>
        </div>
        <Button variant="secondary" asChild>
          <Link href="/admin/queue"><ChevronLeft className="w-4 h-4" />Back to queue</Link>
        </Button>
      </div>
    );
  }
  if (!bundle) return null;

  return (
    <div className="animate-fade-up space-y-6">

      {/* ── Section A: Application Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <Link href="/admin/queue"
            className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-brand-navy mb-3 transition-colors">
            <ChevronLeft className="w-4 h-4" />
            Back to queue
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-bold text-gray-900 font-mono">{bundle.applicant.fullName}</h1>
            {/* Status pill — shows workflow state (PENDING_REVIEW, ESCALATED, …) */}
            <span className={cn(
              'inline-flex items-center text-xs font-bold px-2.5 py-1 rounded-full ring-1',
              bundle.status === 'PENDING_REVIEW'
                ? 'bg-amber-50 text-amber-700 ring-amber-200'
                : bundle.status === 'APPROVED'
                  ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
                  : bundle.status === 'REJECTED'
                    ? 'bg-rose-50 text-rose-700 ring-rose-200'
                    : 'bg-gray-100 text-gray-600 ring-gray-200',
            )}>
              {bundle.status.replace('_', ' ')}
            </span>
            <BandPill band={bundle.scoreBand} />
          </div>
          <div className="flex flex-wrap items-center gap-4 mt-1 text-xs text-gray-400">
            <span className="flex items-center gap-1">
              <User className="w-3 h-3" /> {bundle.applicant.email}
            </span>
            <span className="flex items-center gap-1">
              <Calendar className="w-3 h-3" /> Submitted {formatDate(bundle.submittedAt)}
            </span>
            <span className="font-mono text-gray-300 hidden md:inline">{bundle.id}</span>
          </div>
        </div>

        {/* Score gauge — Section A radial arc */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm px-4 pt-3 pb-2 flex-shrink-0 w-44">
          <ScoreGauge score={bundle.overallScore} />
          <p className="text-[10px] text-gray-400 text-center font-medium uppercase tracking-wider -mt-1">
            AI Score
          </p>
        </div>
      </div>

      {/* ── Action error ── */}
      {actionErr && (
        <div className="rounded-xl bg-rose-50 border border-rose-200 px-4 py-3 text-sm text-rose-700">
          {actionErr}
        </div>
      )}

      {/* ── Prior decisions ── */}
      {bundle.priorDecisions.length > 0 && (
        <div className="bg-amber-50 border border-amber-100 rounded-2xl px-5 py-4">
          <p className="text-xs font-semibold text-amber-700 uppercase tracking-wider mb-2">Prior Decisions</p>
          <div className="space-y-2">
            {bundle.priorDecisions.map(d => (
              <div key={d.id} className="flex items-center gap-3 text-sm">
                <Badge className={
                  d.decision === 'APPROVED'  ? 'bg-emerald-100 text-emerald-700'
                  : d.decision === 'REJECTED'  ? 'bg-rose-100 text-rose-700'
                  : 'bg-amber-100 text-amber-700'
                } dot>{d.decision}</Badge>
                <span className="text-gray-500 text-xs">{d.reasonCodes.join(', ')}</span>
                {d.notes && <span className="text-gray-400 text-xs">· {d.notes}</span>}
                <span className="text-gray-400 text-xs ml-auto">{formatDate(d.decidedAt)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Main: documents (left) + signals + decision (right) ── */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6 items-start">

        {/* Left: Section B (documents) + Section C (face) + Section D (identity) */}
        <div className="space-y-5">

          {/* Section B — Document Evidence */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Eye className="w-4 h-4 text-brand-navy" />
              <h2 className="text-sm font-semibold text-gray-700 font-mono">
                Document Evidence ({bundle.documents.length})
              </h2>
            </div>
            {bundle.documents.length === 0 ? (
              <p className="text-sm text-gray-400 py-8 text-center">No documents uploaded.</p>
            ) : (
              bundle.documents.map(doc => <DocEvidenceCard key={doc.id} doc={doc} />)
            )}
          </div>

          {/* Section C — Face Match */}
          <FaceMatchPanel bundle={bundle} />

          {/* Section D — Identity Correlation (full breakdown) */}
          <IdentityPanel bundle={bundle} />
        </div>

        {/* Right: Section E — Decision */}
        <div className="space-y-4 lg:sticky lg:top-24">
          <DecisionPanel
            bundle={bundle}
            currentUserId={user?.id ?? ''}
            onClaim={handleClaim}
            onDecide={handleDecide}
            claiming={claiming}
            deciding={deciding}
          />
        </div>
      </div>
    </div>
  );
}
