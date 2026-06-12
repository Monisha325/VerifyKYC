'use client';
import { useEffect, useRef, useState } from 'react';
import dynamic                          from 'next/dynamic';
import { useRouter }                    from 'next/navigation';
import type { LivenessVerificationResult } from '@/types/liveness';

const CameraModal       = dynamic(() => import('@/components/liveness/CameraModal'), { ssr: false });
const LivenessStatusCard = dynamic(() => import('@/components/liveness/LivenessStatusCard'), { ssr: false });
import Link                             from 'next/link';
import {
  ShieldCheck, FileText, Clock, CheckCircle2, XCircle,
  ArrowRight, RefreshCw, Loader2, AlertTriangle, ChevronRight, LifeBuoy, Camera, X,
} from 'lucide-react';
import { api }            from '@/lib/api';
import { uploadToCloudinary, sha256Hex } from '@/lib/upload';
import type { UploadParams }             from '@/lib/upload';
import { useAuth }        from '@/context/AuthContext';
import Card, { CardHeader, CardTitle } from '@/components/ui/Card';
import Badge              from '@/components/ui/Badge';
import Button             from '@/components/ui/Button';
import { PageLoader, SkeletonLine } from '@/components/ui/LoadingSpinner';
import {
  cn, formatDate,
  scoreTextColor, scoreBarColor, scoreBandLabel, boostScore,
  APP_STATUS_LABEL, APP_STATUS_COLOR,
  DOC_STATUS_LABEL, DOC_STATUS_COLOR, DOC_KIND_LABEL,
} from '@/lib/utils';
import type { Application, AppStatus, DocStatus } from '@/lib/types';

// ── Applicant-facing reason code labels ──────────────────────────────────────
// Maps reviewer codes to plain-English messages safe to show applicants.
// Internal reviewer notes are never exposed here.
const REASON_CODE_LABELS: Record<string, string> = {
  GENUINE_DOCS:           'Your documents appeared genuine',
  IDENTITY_CONFIRMED:     'Your identity was confirmed',
  FACE_MATCH_PASSED:      'Face matching passed',
  FRAUD_SUSPECTED:        'Potential fraud was detected on your application',
  DOCS_TAMPERED:          'Documents appeared to have been altered',
  IDENTITY_MISMATCH:      'Identity details could not be verified across documents',
  DUPLICATE_APPLICATION:  'A duplicate application was detected',
  INCOMPLETE_DOCS:        'Required documents were incomplete or missing',
  NEEDS_SENIOR_REVIEW:    'Your application requires further review',
  EDGE_CASE:              'Your application raised unusual patterns',
  POLICY_EXCEPTION:       'A policy exception was applied',
};

// ── Low-confidence flag → human-readable reason ──────────────────────────────
// Explains a red (<40) confidence bar in plain English instead of a raw flag code.
const FLAG_REASONS: Record<string, string> = {
  blur_fail:           'Image is too blurry — try retaking in better lighting',
  glare_fail:          'Glare detected — avoid reflective surfaces when photographing',
  resolution_fail:     'Image resolution too low — use a higher quality photo',
  exposure_fail:       'Image is over or underexposed — adjust lighting',
  crop_fail:           'Document not fully visible — ensure full document is in frame',
  ocr_low_confidence:  'Text could not be read clearly from this document',
  type_mismatch:       'Document type could not be confirmed',
  auth_fail:           'Document authenticity check failed',
  tampering:           'Possible tampering detected on this document',
  face_mismatch:       'Face on document does not match your selfie',
  stage_timeout:       'Processing took too long — please re-upload this document',
  quality_check_error: 'Quality check failed — please re-upload a clearer image',
};

const LOW_CONFIDENCE_FALLBACK_REASON = 'Low image quality affected analysis — consider re-uploading a clearer photo';

// ── Status icon map ───────────────────────────────────────────────────────────

function StatusIcon({ status }: { status: AppStatus }) {
  if (status === 'APPROVED')       return <CheckCircle2 className="w-5 h-5 text-emerald-500" />;
  if (status === 'REJECTED')       return <XCircle       className="w-5 h-5 text-rose-500"    />;
  if (status === 'PENDING_REVIEW') return <Clock         className="w-5 h-5 text-amber-500"   />;
  if (status === 'PROCESSING')     return <RefreshCw     className="w-5 h-5 text-blue-500 animate-spin" />;
  return <FileText className="w-5 h-5 text-gray-400" />;
}

// ── Document thumbnail (click → lightbox; placeholder when no image) ─────────
// Shown only for VERIFIED/FAILED docs that have a stored image — matches the
// gallery's gating rule so the thumbnail and lightbox never disagree.

function DocThumbnail({
  doc,
  onOpen,
}: {
  doc:    Application['documents'][number];
  onOpen: () => void;
}) {
  const sizeCls = doc.kind === 'SELFIE' ? 'w-[60px] h-[60px]' : 'w-[80px] h-[60px]';

  if (!doc.cloudinaryUrl || (doc.status !== 'VERIFIED' && doc.status !== 'NEEDS_REVIEW' && doc.status !== 'FAILED')) {
    return (
      <div className={cn('flex-shrink-0 rounded-lg border border-gray-100 bg-gray-50 flex items-center justify-center', sizeCls)}>
        <FileText className="w-5 h-5 text-gray-300" />
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'group flex-shrink-0 overflow-hidden rounded-lg border border-gray-100 bg-gray-900 hover:shadow-card-lg transition-shadow',
        sizeCls,
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={doc.cloudinaryUrl}
        alt={DOC_KIND_LABEL[doc.kind]}
        className="w-full h-full object-cover transition-transform duration-200 group-hover:scale-[1.05]"
        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
      />
    </button>
  );
}

// ── Per-document confidence bar ───────────────────────────────────────────────

const LOW_SCORE_THRESHOLDS: Record<string, number> = {
  AADHAAR:  55,
  PAN:      50,
  PASSPORT: 65,
  DL:       50,
  SELFIE:   45,
  DEFAULT:  55,
};

function DocConfidenceBar({
  doc,
  appId,
  onRefresh,
  onOpenLightbox,
}: {
  doc:            Application['documents'][number];
  appId:          string;
  onRefresh:      () => void;
  onOpenLightbox: (doc: Application['documents'][number]) => void;
}) {
  const raw        = doc.documentVerification?.rawAiResponse;
  const confidence = boostScore(raw?.doc_confidence ?? null);
  const flags      = raw?.flags ?? [];
  const isVerified   = doc.status === 'VERIFIED';
  const isNeedsReview = doc.status === 'NEEDS_REVIEW';
  const isFailed   = doc.status === 'FAILED';
  // Show score bar for any status where the pipeline completed and scored the document
  const isScored   = isVerified || isNeedsReview || isFailed;

  const lowScoreThreshold = LOW_SCORE_THRESHOLDS[doc.kind] ?? LOW_SCORE_THRESHOLDS['DEFAULT'];

  // Below the per-document-type threshold → red bar — surface a plain-English
  // reason instead of raw flag codes. Shown for ANY document with a numeric
  // confidence score, verified or failed — and always falls back to a generic
  // explanation when no flag maps to one.
  const isLowConfidence     = confidence != null && confidence < lowScoreThreshold;
  const lowConfidenceReason = isLowConfidence
    ? (flags.map(f => FLAG_REASONS[f]).find(Boolean) ?? LOW_CONFIDENCE_FALLBACK_REASON)
    : null;

  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [reuploadState, setReuploadState] = useState<'idle' | 'uploading' | 'processing' | 'done'>('idle');

  useEffect(() => () => {
    setReuploadState('idle');
  }, []);

  return (
    <div className="flex items-start gap-3 py-3 border-b border-gray-50 last:border-0">
      <DocThumbnail doc={doc} onOpen={() => onOpenLightbox(doc)} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <span className="text-sm font-medium text-gray-700 truncate">
            {DOC_KIND_LABEL[doc.kind]}
          </span>
          <div className="flex items-center gap-2 flex-shrink-0">
            {confidence != null && isScored && (
              <span className={cn('text-sm font-bold tabular-nums', scoreTextColor(confidence))}>
                {confidence}
              </span>
            )}
            <Badge className={DOC_STATUS_COLOR[doc.status]} dot>
              {DOC_STATUS_LABEL[doc.status]}
            </Badge>
            {(isFailed || isLowConfidence) && doc.kind === 'SELFIE' && reuploadState === 'idle' && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setIsCameraOpen(true)}
              >
                <Camera className="w-3 h-3" />
                Verify Again
              </Button>
            )}
          </div>
        </div>

        {/* Confidence bar / state feedback */}
        {isScored && confidence != null ? (
          <div className="space-y-1">
            <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
              <div
                className={cn('h-full rounded-full score-bar', scoreBarColor(confidence))}
                style={{ width: `${confidence}%` }}
              />
            </div>
            {isLowConfidence && lowConfidenceReason && doc.kind !== 'SELFIE' && (
              <p className="text-xs text-rose-600 mt-1 flex items-start gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                {lowConfidenceReason}
              </p>
            )}
          </div>
        ) : isFailed ? (
          <div className="space-y-1 mt-1">
            <div className="flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 text-rose-500 flex-shrink-0" />
              <span className="text-xs text-rose-600">Verification failed</span>
            </div>
          </div>
        ) : (
          <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
            <div className="h-full w-full skeleton" />
          </div>
        )}

        {reuploadState === 'uploading' && (
          <div className="flex items-center gap-1.5 mt-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-500" />
            <span className="text-xs text-gray-500">Uploading document...</span>
          </div>
        )}
        {reuploadState === 'processing' && (
          <div className="flex items-center gap-1.5 mt-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-500" />
            <span className="text-xs text-gray-500">Analysing document — this takes 30–60 seconds...</span>
          </div>
        )}
        {reuploadState === 'done' && (
          <div className="flex items-center gap-1.5 mt-2">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
            <span className="text-xs text-emerald-600">Analysis complete — updating score...</span>
          </div>
        )}
      </div>

      {/* Liveness camera for re-verification */}
      <CameraModal
        isOpen={isCameraOpen}
        onClose={() => setIsCameraOpen(false)}
        onVerified={async (result: LivenessVerificationResult) => {
          setIsCameraOpen(false);
          const blob = result.capturedImageBlob;
          if (!blob) { onRefresh(); return; }
          try {
            setReuploadState('uploading');
            // Step 1: get signed Cloudinary params for replacement
            const { data: params } = await api.post<UploadParams>(
              `/applications/${appId}/documents/${doc.id}/replace-uploads`,
            );
            // Step 2: upload new selfie directly to Cloudinary
            const file = new File([blob], 'selfie.jpg', { type: 'image/jpeg' });
            const [uploaded, hash] = await Promise.all([
              uploadToCloudinary(file, params, () => {}),
              sha256Hex(file),
            ]);
            // Step 3: register replacement — backend calls enqueueSingleDocument
            await api.post(`/applications/${appId}/documents/${doc.id}/replace`, {
              publicId:  uploaded.public_id,
              secureUrl: uploaded.secure_url,
              sha256:    hash,
            });
            setReuploadState('processing');
            // Give the pipeline ~45s to run, then refresh
            setTimeout(() => {
              setReuploadState('done');
              setTimeout(() => { setReuploadState('idle'); onRefresh(); }, 2000);
            }, 45_000);
          } catch (err) {
            console.error('[verify-again] replace failed:', err);
            setReuploadState('idle');
            onRefresh();
          }
        }}
      />
    </div>
  );
}

// ── Score ring ────────────────────────────────────────────────────────────────

function ScoreRing({ score }: { score: number | null }) {
  const pct  = score ?? 0;
  const r    = 36;
  const circ = 2 * Math.PI * r;
  const dash = (pct / 100) * circ;

  return (
    <div className="relative w-24 h-24 flex-shrink-0">
      <svg viewBox="0 0 88 88" className="-rotate-90 w-24 h-24">
        <circle cx="44" cy="44" r={r} stroke="#f3f4f6" strokeWidth="8" fill="none" />
        <circle
          cx="44" cy="44" r={r}
          stroke={(score === null || score === undefined) ? '#d1d5db' : score >= 70 ? '#10b981' : score >= 40 ? '#f59e0b' : '#ef4444'}
          strokeWidth="8" fill="none"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circ}`}
          style={{ transition: 'stroke-dasharray 1s cubic-bezier(.4,0,.2,1)' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={cn('text-xl font-bold tabular-nums leading-none', scoreTextColor(score))}>
          {score ?? '—'}
        </span>
        <span className="text-[10px] text-gray-400 mt-0.5 font-medium">score</span>
      </div>
    </div>
  );
}

// ── Decision summary (REJECTED / APPROVED) ───────────────────────────────────
// Shows applicant-safe reason codes. Never shows reviewer notes or fraud scores.

function DecisionSummary({ app }: { app: Application }) {
  const decision = app.reviewDecisions?.[0];
  if (!decision || (app.status !== 'REJECTED' && app.status !== 'APPROVED')) return null;

  const isRejected = decision.decision === 'REJECTED';
  const labels = decision.reasonCodes
    .map(code => REASON_CODE_LABELS[code] ?? code.replace(/_/g, ' '))
    .filter(Boolean);

  return (
    <div className={cn(
      'rounded-2xl border px-5 py-4 space-y-3',
      isRejected ? 'bg-rose-50 border-rose-200' : 'bg-emerald-50 border-emerald-200',
    )}>
      <div className="flex items-center gap-2">
        {isRejected
          ? <XCircle       className="w-4 h-4 text-rose-500 flex-shrink-0" />
          : <CheckCircle2  className="w-4 h-4 text-emerald-600 flex-shrink-0" />}
        <p className={cn('text-sm font-semibold', isRejected ? 'text-rose-700' : 'text-emerald-700')}>
          {isRejected ? 'Application not approved' : 'Application approved'}
        </p>
      </div>

      {labels.length > 0 && (
        <div>
          <p className={cn('text-xs font-semibold uppercase tracking-wider mb-2',
            isRejected ? 'text-rose-500' : 'text-emerald-600')}>
            Reason{labels.length > 1 ? 's' : ''}
          </p>
          <ul className="space-y-1.5">
            {labels.map((label, i) => (
              <li key={i} className={cn(
                'flex items-start gap-2 text-sm rounded-lg px-3 py-1.5',
                isRejected ? 'bg-rose-100/60 text-rose-700' : 'bg-emerald-100/60 text-emerald-700',
              )}>
                <span className="mt-0.5 flex-shrink-0">•</span>
                {label}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* CTA */}
      {isRejected ? (
        <div className="flex flex-col sm:flex-row gap-2 pt-1">
          <Button variant="secondary" size="sm" asChild>
            <Link href="/apply">
              Apply again
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <a href="mailto:support@verikyc.dev" className="flex items-center gap-1.5 text-rose-600 hover:text-rose-700">
              <LifeBuoy className="w-3.5 h-3.5" />
              Contact support
            </a>
          </Button>
        </div>
      ) : (
        <p className="text-xs text-emerald-600">
          Your identity has been verified. No further action required.
        </p>
      )}
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center animate-fade-up">
      <div className="w-20 h-20 rounded-2xl bg-brand-navy/5 flex items-center justify-center mb-6">
        <ShieldCheck className="w-10 h-10 text-brand-navy/30" />
      </div>
      <h2 className="text-xl font-bold text-gray-900 mb-2">Start your KYC verification</h2>
      <p className="text-gray-500 text-sm max-w-xs mb-8 leading-relaxed">
        Upload your government ID and selfie once — our AI verifies everything in minutes.
      </p>
      <Button size="lg" asChild>
        <Link href="/apply">
          Start verification
          <ArrowRight className="w-4 h-4" />
        </Link>
      </Button>
      <ul className="mt-8 space-y-2 text-xs text-gray-400">
        {['Takes about 5 minutes', 'Secure end-to-end encryption', 'Reviewed by a human expert'].map(t => (
          <li key={t} className="flex items-center gap-2 justify-center">
            <CheckCircle2 className="w-3.5 h-3.5 text-brand-green flex-shrink-0" />
            {t}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Main dashboard ────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const { user }  = useAuth();
  const router    = useRouter();
  const [app, setApp]               = useState<Application | null>(null);
  const [loading, setLoading]       = useState(true);
  const [error,   setError]         = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [reapplyLoading, setReapplyLoading] = useState(false);
  const [reapplyError,   setReapplyError]   = useState('');
  const [lightboxDoc, setLightboxDoc] = useState<Application['documents'][number] | null>(null);
  const [isLivenessOpen, setIsLivenessOpen] = useState(false);
  const [livenessResult, setLivenessResult] = useState<LivenessVerificationResult | null>(() => {
    if (typeof window === 'undefined') return null;
    try { const s = localStorage.getItem('kyc_liveness'); return s ? JSON.parse(s) : null; } catch { return null; }
  });
  const scorePollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function handleReapply() {
    setReapplyLoading(true);
    setReapplyError('');
    try {
      await api.post(`/applications/${app!.id}/cancel`);
      await api.post('/applications');
      router.push('/apply');
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })
        ?.response?.data?.error ?? 'Could not start a new application. Please try again.';
      setReapplyError(msg);
      setReapplyLoading(false);
    }
  }

  async function load(quiet = false) {
    if (!quiet) setLoading(true);
    else setRefreshing(true);
    setError('');
    try {
      // The backend returns a list of the user's applications; take the latest
      const { data } = await api.get<Application[]>('/applications');
      const list   = Array.isArray(data) ? data : [];
      const sorted   = list.sort((a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
      setApp(sorted[0] ?? null);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })
        ?.response?.data?.error ?? 'Could not load your application';
      setError(msg);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => { load(); }, []);

  // PENDING_REVIEW can be reached by the pipeline's safety-net timeout before
  // finalize() persists overallScore — poll quietly until the score lands.
  useEffect(() => {
    if (!app || app.status !== 'PENDING_REVIEW' || app.overallScore !== null) return;
    if (scorePollRef.current) return;

    const startedAt = Date.now();
    scorePollRef.current = setInterval(async () => {
      if (Date.now() - startedAt > 10 * 60 * 1000) {
        clearInterval(scorePollRef.current!);
        scorePollRef.current = null;
        return;
      }
      try {
        const { data } = await api.get<Application>(`/applications/${app.id}`);
        if (data.overallScore !== null) {
          clearInterval(scorePollRef.current!);
          scorePollRef.current = null;
          load(true);
        }
      } catch { /* ignore transient poll errors */ }
    }, 5000);

    return () => {
      if (scorePollRef.current) {
        clearInterval(scorePollRef.current);
        scorePollRef.current = null;
      }
    };
  }, [app?.id, app?.status, app?.overallScore]);

  const firstName = user?.fullName?.split(' ')[0] ?? 'there';

  if (loading) return <PageLoader />;

  return (
    <div className="animate-fade-up">

      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-4 mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            Hello, {firstName} 👋
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {app ? 'Your verification status is below.' : 'Begin your identity verification to get started.'}
          </p>
        </div>
        {app && (
          <Button
            variant="ghost" size="sm"
            onClick={() => load(true)}
            loading={refreshing}
            className="flex-shrink-0"
          >
            <RefreshCw className="w-4 h-4" />
            Refresh
          </Button>
        )}
      </div>

      {error && (
        <div className="mb-6 rounded-xl bg-rose-50 border border-rose-200 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      {!app ? (
        <EmptyState />
      ) : (
        <div className="space-y-6">

          {/* ── Status card ── */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <StatusIcon status={app.status} />
                <CardTitle className="text-lg">Verification Status</CardTitle>
              </div>
              <Badge className={APP_STATUS_COLOR[app.status]} dot>
                {APP_STATUS_LABEL[app.status]}
              </Badge>
            </CardHeader>

            <div className="flex flex-col sm:flex-row gap-6">
              {/* Score ring */}
              <div className="flex flex-col items-center justify-center gap-2 bg-gray-50 rounded-2xl p-6 sm:p-8">
                <ScoreRing score={boostScore(app.overallScore)} />
                <div className="text-center mt-1">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Band</p>
                  <p className={cn(
                    'text-sm font-bold mt-0.5',
                    app.scoreBand === 'FAST_TRACK' ? 'text-emerald-600'
                    : app.scoreBand === 'STANDARD' ? 'text-amber-600'
                    : app.scoreBand === 'FLAGGED'  ? 'text-rose-600'
                    : 'text-gray-400',
                  )}>
                    {scoreBandLabel(app.scoreBand, boostScore(app.overallScore))}
                  </p>
                </div>
              </div>

              {/* Timeline */}
              <div className="flex-1 grid grid-cols-2 sm:grid-cols-3 gap-4">
                {[
                  { label: 'Submitted',  value: formatDate(app.submittedAt) },
                  { label: 'Completed',  value: formatDate(app.completedAt) },
                  { label: 'Documents',  value: `${(app.documents ?? []).length} uploaded` },
                ].map(({ label, value }) => (
                  <div key={label} className="bg-gray-50 rounded-xl p-4">
                    <p className="text-xs text-gray-400 font-medium uppercase tracking-wider mb-1">
                      {label}
                    </p>
                    <p className="text-sm font-semibold text-gray-800">{value}</p>
                  </div>
                ))}

                {/* Status message */}
                <div className="col-span-2 sm:col-span-3">
                  <StatusMessage status={app.status} />
                </div>
              </div>
            </div>
          </Card>

          {/* ── Decision reason codes (REJECTED / APPROVED) ── */}
          <DecisionSummary app={app} />

          {/* ── Re-apply CTA (REJECTED only) ── */}
          {app.status === 'REJECTED' && (
            <div className="rounded-2xl border border-gray-200 bg-white p-5 space-y-3">
              <div>
                <p className="text-sm font-semibold text-gray-900">Ready to try again?</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  Start a new application with corrected or updated documents.
                </p>
              </div>
              {reapplyError && (
                <div className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
                  {reapplyError}
                </div>
              )}
              <Button size="sm" loading={reapplyLoading} onClick={handleReapply}>
                Start New Application
                <ArrowRight className="w-3.5 h-3.5" />
              </Button>
            </div>
          )}

          {/* ── Liveness verification card ── */}
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Liveness Check</p>
            <LivenessStatusCard
              result={livenessResult}
              onRetry={() => {
                if (!livenessResult) {
                  router.push('/apply');
                } else {
                  setIsLivenessOpen(true);
                }
              }}
            />
          </div>

          {/* Camera modal for re-verification */}
          <CameraModal
            isOpen={isLivenessOpen}
            onClose={() => setIsLivenessOpen(false)}
            onVerified={result => {
              setIsLivenessOpen(false);
              setLivenessResult(result);
              try { localStorage.setItem('kyc_liveness', JSON.stringify(result)); } catch { /* ignore */ }
            }}
          />

          {/* ── Documents card ── */}
          {(app.documents ?? []).length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Documents & Confidence</CardTitle>
                <span className="text-xs text-gray-400">
                  {(app.documents ?? []).filter(d => d.status === 'VERIFIED').length}/{(app.documents ?? []).length} verified
                </span>
              </CardHeader>
              <div className="divide-y divide-gray-50">
                {(app.documents ?? []).map(doc => (
                  <DocConfidenceBar
                    key={doc.id}
                    doc={doc}
                    appId={app.id}
                    onRefresh={() => load(true)}
                    onOpenLightbox={setLightboxDoc}
                  />
                ))}
              </div>
            </Card>
          )}

          {/* ── Document lightbox ── */}
          {lightboxDoc?.cloudinaryUrl && (
            <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
              <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setLightboxDoc(null)} />
              <div className="relative max-w-3xl w-full max-h-[85vh] animate-fade-up">
                <button
                  type="button"
                  onClick={() => setLightboxDoc(null)}
                  aria-label="Close"
                  className="absolute -top-10 right-0 text-white/80 hover:text-white transition-colors"
                >
                  <X className="w-6 h-6" />
                </button>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={lightboxDoc.cloudinaryUrl}
                  alt={DOC_KIND_LABEL[lightboxDoc.kind]}
                  className="w-full h-full max-h-[85vh] object-contain rounded-2xl"
                />
              </div>
            </div>
          )}

          {/* ── Start new / continue CTA ── */}
          {(app.status === 'DRAFT') && (
            <div className="rounded-2xl bg-brand-navy/4 border border-brand-navy/10 p-5 flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-brand-navy">Application in draft</p>
                <p className="text-xs text-gray-500 mt-0.5">Continue uploading your documents.</p>
              </div>
              <Button size="sm" asChild>
                <Link href="/apply">
                  Continue
                  <ChevronRight className="w-4 h-4" />
                </Link>
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatusMessage({ status }: { status: AppStatus }) {
  const messages: Partial<Record<AppStatus, { icon: React.ReactNode; text: string; cls: string }>> = {
    PROCESSING: {
      icon: <RefreshCw className="w-4 h-4 animate-spin flex-shrink-0" />,
      text: 'Our AI is verifying your documents. This usually takes 1–2 minutes.',
      cls:  'bg-blue-50 text-blue-700 border-blue-100',
    },
    PENDING_REVIEW: {
      icon: <Clock className="w-4 h-4 flex-shrink-0" />,
      text: 'AI analysis complete. A human reviewer will make the final decision — typically within 1 business day.',
      cls:  'bg-amber-50 text-amber-700 border-amber-100',
    },
    APPROVED: {
      icon: <CheckCircle2 className="w-4 h-4 flex-shrink-0" />,
      text: 'Congratulations! Your identity has been verified successfully.',
      cls:  'bg-emerald-50 text-emerald-700 border-emerald-100',
    },
    REJECTED: {
      icon: <XCircle className="w-4 h-4 flex-shrink-0" />,
      text: 'Your application was not approved. Please contact support if you believe this is an error.',
      cls:  'bg-rose-50 text-rose-700 border-rose-100',
    },
  };

  const m = messages[status];
  if (!m) return null;

  return (
    <div className={cn('flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm', m.cls)}>
      {m.icon}
      <p>{m.text}</p>
    </div>
  );
}
