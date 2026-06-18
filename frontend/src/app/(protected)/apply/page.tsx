'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import dynamic          from 'next/dynamic';
import { useRouter }    from 'next/navigation';
import { useDropzone }  from 'react-dropzone';
import Link             from 'next/link';
import {
  ShieldCheck, Upload, CheckCircle2, Clock, ArrowRight, ArrowLeft,
  FileText, AlertCircle, Loader2, RefreshCw, X,
  Image as ImageIcon, ChevronRight, Sparkles, Camera,
} from 'lucide-react';
import { api }   from '@/lib/api';
import type { LivenessVerificationResult } from '@/types/liveness';
import { persistedLivenessResult } from '@/utils/livenessHelpers';

const CameraModal = dynamic(() => import('@/components/liveness/CameraModal'), { ssr: false });
import {
  cn, scoreTextColor, scoreBarColor, scoreBandLabel, boostScore,
  DOC_KIND_LABEL, DOC_STATUS_LABEL, DOC_STATUS_COLOR,
} from '@/lib/utils';
import {
  validateFile, sha256Hex, uploadToCloudinary, pdfToImage,
  type UploadParams, type CloudinaryUploadResult,
} from '@/lib/upload';
import Button             from '@/components/ui/Button';
import Badge              from '@/components/ui/Badge';
import { PageLoader }     from '@/components/ui/LoadingSpinner';
import { useApplication } from '@/context/ApplicationContext';
import type { DocKind, Application } from '@/lib/types';

// ── Constants ─────────────────────────────────────────────────────────────────

const DOC_KINDS: DocKind[] = ['AADHAAR', 'PAN', 'PASSPORT', 'DRIVING_LICENCE', 'SELFIE'];

const DOC_HINTS: Record<DocKind, string> = {
  AADHAAR:         'Front side of your Aadhaar card',
  PAN:             'PAN card — name must be clearly visible',
  PASSPORT:        'Passport bio-data page (page with your photo)',
  DRIVING_LICENCE: 'Front of your driving licence',
  SELFIE:          'Clear photo of your face — no sunglasses, good lighting',
};

type Step = 'start' | 'upload' | 'submit' | 'processing' | 'result';

// ── Per-doc upload state machine ──────────────────────────────────────────────

type DocUploadState =
  | { status: 'idle' }
  | { status: 'validating' }
  | { status: 'converting' }
  | { status: 'getting-params' }
  | { status: 'uploading';    progress: number; preview: string }
  | { status: 'registering'; preview: string }
  | { status: 'done';        preview: string; docId: string }
  | { status: 'error';       message: string; preview?: string };

// ── Step indicator ────────────────────────────────────────────────────────────

const STEPS: { id: Step; label: string }[] = [
  { id: 'start',      label: 'Start'      },
  { id: 'upload',     label: 'Documents'  },
  { id: 'submit',     label: 'Submit'     },
  { id: 'processing', label: 'Processing' },
  { id: 'result',     label: 'Result'     },
];

function StepIndicator({ current }: { current: Step }) {
  const idx = STEPS.findIndex(s => s.id === current);
  return (
    <div className="flex items-center justify-center mb-10 select-none">
      {STEPS.map((step, i) => {
        const done   = i < idx;
        const active = i === idx;
        return (
          <React.Fragment key={step.id}>
            <div className="flex flex-col items-center gap-1.5">
              <div className={cn(
                'w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-all',
                done   ? 'bg-brand-green text-white shadow-sm'
                : active ? 'bg-brand-navy text-white shadow-md ring-4 ring-brand-navy/20'
                : 'bg-gray-100 text-gray-400',
              )}>
                {done ? <CheckCircle2 className="w-4 h-4" /> : i + 1}
              </div>
              <span className={cn(
                'text-[11px] font-medium hidden sm:block',
                active ? 'text-brand-navy' : done ? 'text-brand-green' : 'text-gray-400',
              )}>
                {step.label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div className={cn(
                'h-0.5 w-10 sm:w-14 mx-1 mb-4 sm:mb-5 rounded-full transition-colors',
                i < idx ? 'bg-brand-green' : 'bg-gray-200',
              )} />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ── Document upload card ──────────────────────────────────────────────────────

function DocUploadCard({
  kind, state, onFile,
}: {
  kind:   DocKind;
  state:  DocUploadState;
  onFile: (kind: DocKind, file: File) => void;
}) {
  const busy    = state.status === 'uploading' || state.status === 'registering' || state.status === 'getting-params' || state.status === 'validating' || state.status === 'converting';
  const isDone  = state.status === 'done';
  const isError = state.status === 'error';
  const statePreview = 'preview' in state ? state.preview : null;

  // Remember the last successfully-registered preview so a replace-in-progress
  // (or a failed replace) keeps showing the existing image — never the empty
  // dropzone or a half-uploaded new file — until the new one lands.
  const lastDonePreview = useRef<string | null>(null);
  if (state.status === 'done') lastDonePreview.current = state.preview;
  const replacing  = lastDonePreview.current !== null && state.status !== 'done';
  const preview    = replacing ? lastDonePreview.current : statePreview;
  const canReplace = !busy && (isDone || (isError && replacing));

  const replaceInputRef = useRef<HTMLInputElement>(null);
  function handleReplacePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) onFile(kind, file);
    e.target.value = '';
  }

  const onDrop = useCallback((accepted: File[]) => {
    if (accepted[0]) onFile(kind, accepted[0]);
  }, [kind, onFile]);

  const accept: Record<string, string[]> = kind === 'SELFIE'
    ? { 'image/jpeg': [], 'image/jpg': [], 'image/png': [], 'image/webp': [] }
    : { 'image/jpeg': [], 'image/jpg': [], 'image/png': [], 'image/webp': [], 'application/pdf': [] };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept,
    maxFiles: 1,
    multiple: false,
    disabled: busy || isDone,
  });

  return (
    <div className={cn(
      'rounded-2xl border-2 transition-all duration-200 overflow-hidden',
      isDone    ? 'border-emerald-200 bg-emerald-50/40'
      : isError ? 'border-rose-200 bg-rose-50/30'
      : isDragActive ? 'border-brand-navy bg-brand-navy/5 scale-[1.01]'
      : 'border-gray-200 bg-white hover:border-gray-300',
    )}>
      <div className="p-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-2 mb-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-900 truncate">{DOC_KIND_LABEL[kind]}</p>
            <p className="text-xs text-gray-400 mt-0.5 leading-snug">{DOC_HINTS[kind]}</p>
          </div>
          {isDone  && <CheckCircle2 className="w-5 h-5 text-emerald-500 flex-shrink-0 mt-0.5" />}
          {isError && <AlertCircle  className="w-5 h-5 text-rose-500 flex-shrink-0 mt-0.5"   />}
        </div>

        {/* Preview image OR dropzone */}
        {preview ? (
          <div className="relative rounded-xl overflow-hidden bg-gray-100 aspect-[3/2]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={preview} alt={DOC_KIND_LABEL[kind]} className="w-full h-full object-cover" />
            {busy && (
              <div className="absolute inset-0 bg-black/50 flex flex-col items-center justify-center gap-2">
                <Loader2 className="w-6 h-6 text-white animate-spin" />
                <span className="text-white text-xs font-medium">
                  {state.status === 'uploading'
                    ? `Uploading ${(state as Extract<DocUploadState, { status: 'uploading' }>).progress}%`
                    : state.status === 'converting'
                    ? 'Converting PDF...'
                    : 'Processing…'}
                </span>
              </div>
            )}
            {canReplace && (
              <>
                <input
                  ref={replaceInputRef}
                  type="file"
                  accept={kind === 'SELFIE'
                    ? 'image/jpeg,image/png,image/webp'
                    : 'image/jpeg,image/png,image/webp,application/pdf'}
                  className="hidden"
                  onChange={handleReplacePick}
                />
                <button
                  type="button"
                  onClick={() => replaceInputRef.current?.click()}
                  title="Replace this document"
                  aria-label="Replace this document"
                  className="absolute bottom-2 right-2 w-8 h-8 rounded-full bg-white/90 shadow-md border border-gray-200 flex items-center justify-center text-gray-500 hover:text-brand-navy hover:border-brand-navy/40 hover:bg-white transition-colors"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
              </>
            )}
          </div>
        ) : state.status === 'converting' ? (
          // Fresh PDF upload — no prior image to overlay onto, so show a
          // standalone status card while pdf.js renders the first page.
          <div className="relative rounded-xl overflow-hidden bg-gray-100 aspect-[3/2] flex flex-col items-center justify-center gap-2">
            <Loader2 className="w-6 h-6 text-brand-navy/40 animate-spin" />
            <span className="text-xs font-medium text-gray-500">Converting PDF...</span>
          </div>
        ) : (
          <div
            {...getRootProps()}
            className={cn(
              'rounded-xl border-2 border-dashed aspect-[3/2] flex flex-col items-center justify-center gap-2 cursor-pointer transition-colors',
              isDragActive
                ? 'border-brand-navy bg-brand-navy/5'
                : 'border-gray-200 hover:border-brand-navy/40 hover:bg-gray-50',
              (busy || isDone) && 'cursor-default opacity-60',
            )}
          >
            <input {...getInputProps()} />
            <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center">
              <Upload className="w-5 h-5 text-gray-400" />
            </div>
            <div className="text-center px-4">
              <p className="text-xs font-medium text-gray-600">
                {isDragActive ? 'Drop here' : 'Click or drag & drop'}
              </p>
              <p className="text-[10px] text-gray-400 mt-0.5">JPG · PNG · WebP · PDF · max 10 MB</p>
            </div>
          </div>
        )}

        {/* Upload progress bar */}
        {state.status === 'uploading' && (
          <div className="mt-3 h-1.5 rounded-full bg-gray-100 overflow-hidden">
            <div
              className="h-full bg-brand-navy rounded-full transition-all duration-200"
              style={{ width: `${state.progress}%` }}
            />
          </div>
        )}

        {/* Error + retry */}
        {isError && (
          <>
            <p className="mt-2 text-xs text-rose-600 flex items-start gap-1.5">
              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              {state.message}
            </p>
            {!replacing && (
              <div {...getRootProps()} className="mt-2 cursor-pointer">
                <input {...getInputProps()} />
                <Button variant="ghost" size="sm" className="w-full text-xs text-rose-600 hover:bg-rose-50">
                  Try again
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Selfie capture card — liveness only, no file input ───────────────────────

function SelfieCaptureCard({
  state,
  livenessResult,
  onOpen,
}: {
  state:          DocUploadState;
  livenessResult: import('@/types/liveness').LivenessVerificationResult | null;
  onOpen:         () => void;
}) {
  const isDone  = state.status === 'done';
  const isError = state.status === 'error';
  const busy    = ['uploading','registering','getting-params','validating'].includes(state.status);
  const preview = isDone ? (state as Extract<DocUploadState, { status: 'done' }>).preview : null;
  const livenessVerified = livenessResult?.status === 'verified';

  return (
    <div className={cn(
      'rounded-2xl border-2 transition-all duration-200 overflow-hidden',
      isDone    ? 'border-emerald-200 bg-emerald-50/40'
      : isError ? 'border-rose-200 bg-rose-50/30'
      : 'border-gray-200 bg-white',
    )}>
      <div className="p-4">
        <div className="flex items-start justify-between gap-2 mb-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-900">Selfie</p>
            <p className="text-xs text-gray-400 mt-0.5 leading-snug">Live face capture · liveness check required</p>
          </div>
          {isDone  && <CheckCircle2 className="w-5 h-5 text-emerald-500 flex-shrink-0 mt-0.5" />}
          {isError && <AlertCircle  className="w-5 h-5 text-rose-500 flex-shrink-0 mt-0.5"   />}
        </div>

        {/* Preview after successful upload */}
        {preview ? (
          <div className="relative rounded-xl overflow-hidden bg-gray-100 aspect-[3/2]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={preview} alt="Selfie" className="w-full h-full object-cover scale-x-[-1]" />
            {livenessVerified && (
              <div className="absolute top-2 left-2 bg-emerald-500 text-white text-[10px] font-bold px-2 py-0.5 rounded-full">
                ✓ Verified · {livenessResult!.confidence.toFixed(1)}%
              </div>
            )}
            <button
              type="button"
              onClick={onOpen}
              title="Retake selfie"
              className="absolute bottom-2 right-2 w-8 h-8 rounded-full bg-white/90 shadow-md border border-gray-200 flex items-center justify-center text-gray-500 hover:text-brand-navy hover:border-brand-navy/40 hover:bg-white transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : busy ? (
          <div className="relative rounded-xl overflow-hidden bg-gray-100 aspect-[3/2] flex flex-col items-center justify-center gap-2">
            <Loader2 className="w-6 h-6 text-brand-navy/40 animate-spin" />
            <span className="text-xs font-medium text-gray-500">Uploading selfie...</span>
          </div>
        ) : (
          /* Open camera CTA */
          <button
            type="button"
            onClick={onOpen}
            className={cn(
              'w-full rounded-xl border-2 border-dashed aspect-[3/2] flex flex-col items-center justify-center gap-3 transition-colors',
              'border-gray-200 hover:border-brand-navy/40 hover:bg-gray-50',
            )}
          >
            <div className="w-12 h-12 rounded-full bg-brand-navy/10 flex items-center justify-center">
              <Camera className="w-6 h-6 text-brand-navy/60" />
            </div>
            <div className="text-center px-4">
              <p className="text-xs font-semibold text-gray-700">Open Camera</p>
              <p className="text-[10px] text-gray-400 mt-0.5">Webcam required · liveness check</p>
            </div>
          </button>
        )}

        {isError && (
          <p className="mt-2 text-xs text-rose-600 flex items-start gap-1.5">
            <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            {(state as Extract<DocUploadState, { status: 'error' }>).message}
          </p>
        )}
      </div>
    </div>
  );
}

// ── Processing step (display-only — parent owns the polling) ──────────────────

function ProcessingStep({ app }: { app: Application | null }) {
  const allDone = app?.documents.every(d => d.status === 'VERIFIED' || d.status === 'FAILED');

  return (
    <div className="flex flex-col items-center text-center gap-6">
      <div className="relative">
        <div className="w-20 h-20 rounded-full bg-brand-navy/5 flex items-center justify-center">
          <ShieldCheck className="w-10 h-10 text-brand-navy/40" />
        </div>
        <div className="absolute -top-1 -right-1 w-7 h-7 rounded-full bg-brand-navy flex items-center justify-center">
          <Loader2 className="w-4 h-4 text-white animate-spin" />
        </div>
      </div>

      <div>
        <h2 className="text-xl font-bold text-gray-900">
          {allDone ? 'Running Face Match…' : 'AI Verification in Progress'}
        </h2>
        <p className="text-sm text-gray-500 mt-1.5 max-w-xs leading-relaxed">
          {allDone
            ? 'Documents verified — comparing your selfie against your ID photo. This can take up to 60 seconds on first run.'
            : 'Our AI is analysing your documents — OCR, authenticity checks, face matching.'}
        </p>
      </div>

      {/* Per-document status */}
      {app && app.documents.length > 0 && (
        <div className="w-full max-w-xs space-y-2">
          {app.documents.map(doc => (
            <div key={doc.id}
              className="flex items-center justify-between bg-gray-50 rounded-xl px-4 py-2.5 gap-3">
              <span className="text-sm text-gray-700 truncate">{DOC_KIND_LABEL[doc.kind]}</span>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                {doc.status === 'VERIFIED'     && <CheckCircle2 className="w-4 h-4 text-emerald-500" />}
                {doc.status === 'FAILED'       && <X           className="w-4 h-4 text-rose-500"    />}
                {doc.status === 'NEEDS_REVIEW' && <Clock       className="w-4 h-4 text-amber-500"   />}
                {(doc.status === 'PROCESSING' || doc.status === 'QUEUED') &&
                  <Loader2 className="w-4 h-4 text-amber-500 animate-spin" />}
                <Badge className={DOC_STATUS_COLOR[doc.status]} dot>
                  {DOC_STATUS_LABEL[doc.status]}
                </Badge>
              </div>
            </div>
          ))}
        </div>
      )}

      {allDone && (
        <div className="flex items-center gap-2 text-sm text-blue-700 bg-blue-50 rounded-xl px-4 py-2.5">
          <Loader2 className="w-4 h-4 animate-spin flex-shrink-0" />
          Matching face against ID — almost done…
        </div>
      )}

      <p className="text-xs text-gray-400 flex items-center gap-1.5">
        <RefreshCw className="w-3 h-3 animate-spin" />
        Checking every 3 seconds…
      </p>
    </div>
  );
}

// ── Result step ───────────────────────────────────────────────────────────────

function ResultStep({ app }: { app: Application }) {
  return (
    <div className="flex flex-col items-center text-center gap-6">
      <div className="w-20 h-20 rounded-2xl bg-amber-50 flex items-center justify-center">
        <Clock className="w-10 h-10 text-amber-500" />
      </div>

      <div>
        <h2 className="text-xl font-bold text-gray-900">Under Human Review</h2>
        <p className="text-sm text-gray-500 mt-1.5 max-w-sm leading-relaxed">
          Your AI analysis is complete. A certified reviewer will make the final
          decision — typically within 1 business day.
        </p>
      </div>

      {/* Overall score ring + band */}
      {app.overallScore != null && (
        <div className="w-full max-w-xs bg-gray-50 rounded-2xl p-5">
          {(() => { const s = boostScore(app.overallScore)!; return (<>
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-semibold text-gray-700">AI Confidence Score</span>
            <span className={cn('text-2xl font-bold tabular-nums', scoreTextColor(s))}>
              {s}
            </span>
          </div>
          <div className="h-2.5 rounded-full bg-gray-200 overflow-hidden">
            <div
              className={cn('h-full rounded-full score-bar', scoreBarColor(s))}
              style={{ width: `${s}%` }}
            />
          </div>
          <div className="flex items-center justify-between mt-2">
            <span className="text-xs text-gray-400">Recommendation band</span>
            <span className={cn(
              'text-xs font-bold',
              app.scoreBand === 'FAST_TRACK' ? 'text-emerald-600'
              : app.scoreBand === 'STANDARD' ? 'text-amber-600'
              : 'text-rose-600',
            )}>
              {scoreBandLabel(app.scoreBand, s)}
            </span>
          </div>
          </>); })()}
        </div>
      )}

      {/* Per-document confidence */}
      {app.documents.length > 0 && (
        <div className="w-full max-w-xs space-y-2">
          {app.documents.map(doc => {
            const conf = boostScore(doc.documentVerification?.rawAiResponse?.doc_confidence ?? null);
            return (
              <div key={doc.id} className="bg-white border border-gray-100 rounded-xl px-4 py-3 text-left">
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <span className="text-xs font-medium text-gray-700">{DOC_KIND_LABEL[doc.kind]}</span>
                  {conf != null && (
                    <span className={cn('text-xs font-bold tabular-nums', scoreTextColor(conf))}>
                      {conf}
                    </span>
                  )}
                </div>
                {conf != null ? (
                  <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
                    <div className={cn('h-full rounded-full score-bar', scoreBarColor(conf))}
                         style={{ width: `${conf}%` }} />
                  </div>
                ) : (
                  <div className="skeleton h-1.5 w-full" />
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Human-reviewer disclaimer */}
      <div className="w-full max-w-xs bg-blue-50 border border-blue-100 rounded-xl px-4 py-3 text-left">
        <div className="flex items-start gap-2">
          <Sparkles className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-blue-700 leading-relaxed">
            <strong>AI assists — humans decide.</strong> The score above guides our
            reviewers but never auto-approves your application. A qualified reviewer
            makes the final call.
          </p>
        </div>
      </div>

      <Button asChild>
        <Link href="/dashboard">
          Go to Dashboard
          <ArrowRight className="w-4 h-4" />
        </Link>
      </Button>
    </div>
  );
}

// ── Main wizard ───────────────────────────────────────────────────────────────

export default function ApplyPage() {
  const router                                   = useRouter();
  const { app: latestApp, loading: appLoading }  = useApplication();

  const [guardDone,  setGuardDone]  = useState(false);
  const [step,       setStep]       = useState<Step>('start');
  const [appId,      setAppId]      = useState<string | null>(null);
  const [app,        setApp]        = useState<Application | null>(null);
  const [globalErr,  setGlobalErr]  = useState('');
  const [creating,   setCreating]   = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [isLivenessModalOpen, setIsLivenessModalOpen] = useState(false);
  const [livenessResult, setLivenessResult] = useState<LivenessVerificationResult | null>(() => {
    if (typeof window === 'undefined') return null;
    try { const s = localStorage.getItem('kyc_liveness'); return s ? JSON.parse(s) : null; } catch { return null; }
  });

  const [docStates, setDocStates] = useState<Record<DocKind, DocUploadState>>(
    () => Object.fromEntries(DOC_KINDS.map(k => [k, { status: 'idle' }])) as Record<DocKind, DocUploadState>,
  );


  // Route guard — runs once after context resolves.
  // Blocks the wizard until we know the user is allowed here.
  useEffect(() => {
    if (appLoading) return;

    if (!latestApp || latestApp.status === 'REJECTED') {
      // No active app or rejected — start fresh (or apply again)
      setGuardDone(true);
      return;
    }

    if (latestApp.status === 'DRAFT') {
      // Resume existing draft using the authoritative backend ID
      setAppId(latestApp.id);
      sessionStorage.setItem('verikyc_apply_id', latestApp.id);
      setStep('upload');
      setGuardDone(true);
      return;
    }

    // SUBMITTED / PROCESSING / PENDING_REVIEW / APPROVED → send to dashboard
    router.replace('/dashboard');
  }, [appLoading, latestApp, router]);

  // ── Liveness verification callback ──────────────────────────────────────────
  const handleLivenessVerified = useCallback(async (result: LivenessVerificationResult) => {
    setIsLivenessModalOpen(false);
    setLivenessResult(result);
    try { localStorage.setItem('kyc_liveness', JSON.stringify(result)); } catch { /* ignore */ }

    // Upload the captured blob as the SELFIE document
    if (result.capturedImageBlob && appId) {
      const file = new File([result.capturedImageBlob], 'selfie.jpg', { type: 'image/jpeg' });
      await handleFile('SELFIE', file);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId]);

  // ── Step 2: Upload a single document ────────────────────────────────────────
  // useCallback must live above the early return — hooks must always be called
  // in the same order regardless of render path.
  const handleFile = useCallback(async (kind: DocKind, file: File) => {
    if (!appId) return;
    console.log(`[handleFile] file received: name=${file.name} type=${file.type} size=${file.size}`);

    // PDFs are converted to a first-page JPEG up front — from here on the
    // converted file flows through the exact same upload path as any image.
    let workingFile = file;
    if (file.type === 'application/pdf') {
      console.log(`[handleFile] PDF detected — starting conversion`);
      setDocState(kind, { status: 'converting' });
      try {
        workingFile = await pdfToImage(file);
        console.log(`[handleFile] PDF conversion complete — workingFile type=${workingFile.type} size=${workingFile.size}`);
      } catch (e: unknown) {
        setDocState(kind, { status: 'error', message: (e as Error).message });
        return;
      }
    }

    const preview = URL.createObjectURL(workingFile);

    // Validate
    setDocState(kind, { status: 'validating' });
    const validErr = validateFile(workingFile);
    if (validErr) { setDocState(kind, { status: 'error', message: validErr, preview }); return; }

    // Get signed params from our backend
    setDocState(kind, { status: 'getting-params' });
    let params: UploadParams;
    try {
      const { data } = await api.post<UploadParams>(`/applications/${appId}/uploads`, { kind });
      params = data;
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error
        ?? 'Could not get upload parameters.';
      setDocState(kind, { status: 'error', message: msg, preview });
      return;
    }

    // Upload directly to Cloudinary — bytes never touch our backend
    let cloudResult: CloudinaryUploadResult;
    try {
      cloudResult = await uploadToCloudinary(workingFile, params, (pct) => {
        setDocState(kind, { status: 'uploading', progress: pct, preview });
      });
    } catch (e: unknown) {
      setDocState(kind, { status: 'error', message: (e as Error).message, preview });
      return;
    }

    // Compute SHA-256 in the browser (Web Crypto API)
    const sha256 = await sha256Hex(workingFile);

    // Register with our backend
    setDocState(kind, { status: 'registering', preview });
    try {
      const { data: doc } = await api.post<{ id: string }>(
        `/applications/${appId}/documents`,
        { kind, publicId: cloudResult.public_id, secureUrl: cloudResult.secure_url, sha256 },
      );
      setDocState(kind, { status: 'done', preview, docId: doc.id });
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error
        ?? 'Could not register document.';
      setDocState(kind, { status: 'error', message: msg, preview });
    }
  }, [appId]);

  // ── Selfie: liveness capture completion ─────────────────────────────────────

  // ── Step 4: Polling timer — useRef + useEffect must precede early return ─────

  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (step !== 'processing' || !appId) return;

    let active = true;

    async function tick() {
      if (!active || !appId) return;
      try {
        const { data } = await api.get<Application>(`/applications/${appId}`);
        if (!active) return;
        setApp(data);
        const terminal = data.status === 'PENDING_REVIEW'
          || data.status === 'APPROVED'
          || data.status === 'REJECTED';
        if (terminal) { setStep('result'); return; }
      } catch { /* keep polling on network errors */ }
      if (active) pollTimer.current = setTimeout(tick, 3000);
    }

    tick();
    return () => {
      active = false;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [step, appId]);

  // ── All hooks declared above — early return is safe from here ────────────────
  // Show spinner until guard clears (prevents flashing the wizard then redirecting)
  if (!guardDone) return <PageLoader />;

  // ── Non-hook helpers ──────────────────────────────────────────────────────────

  function setDocState(kind: DocKind, state: DocUploadState) {
    setDocStates(prev => ({ ...prev, [kind]: state }));
  }

  // ── Step 1: Create application ───────────────────────────────────────────────

  async function handleStart() {
    setCreating(true);
    setGlobalErr('');
    try {
      const { data } = await api.post<{ id: string }>('/applications');
      setAppId(data.id);
      sessionStorage.setItem('verikyc_apply_id', data.id);
      
      // Clear any old liveness state so the user must capture a new selfie
      setLivenessResult(null);
      try { localStorage.removeItem('kyc_liveness'); } catch { /* ignore */ }

      setStep('upload');
    } catch (e: unknown) {
      setGlobalErr(
        (e as { response?: { data?: { error?: string } } })?.response?.data?.error
        ?? 'Could not create application. Please try again.',
      );
    } finally {
      setCreating(false);
    }
  }

  // ── Step 3: Submit ───────────────────────────────────────────────────────────

  const doneDocs  = DOC_KINDS.filter(k => docStates[k].status === 'done');
  const hasSelfie = doneDocs.includes('SELFIE');
  const hasIdDoc  = doneDocs.some(k => k !== 'SELFIE');
  const hasEnough = hasSelfie && hasIdDoc;

  async function handleSubmit() {
    if (!appId) return;
    setSubmitting(true);
    setGlobalErr('');
    try {
      await api.post(`/applications/${appId}/submit`);
      sessionStorage.removeItem('verikyc_apply_id');
      setStep('processing');
    } catch (e: unknown) {
      setGlobalErr(
        (e as { response?: { data?: { error?: string } } })?.response?.data?.error
        ?? 'Submission failed. Please try again.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-2xl mx-auto animate-fade-up">
      <StepIndicator current={step} />

      {/* ── Step 1: Start ── */}
      {step === 'start' && (
        <div className="flex flex-col items-center text-center gap-6">
          <div className="w-20 h-20 rounded-2xl bg-brand-navy flex items-center justify-center shadow-lg">
            <ShieldCheck className="w-10 h-10 text-brand-green" />
          </div>

          <div>
            <h1 className="text-2xl font-bold text-gray-900">Start KYC Verification</h1>
            <p className="mt-2 text-gray-500 text-sm max-w-sm leading-relaxed">
              We&apos;ll guide you through uploading your identity documents.
              The whole process takes about 5 minutes.
            </p>
          </div>

          <div className="w-full max-w-xs space-y-3 text-left">
            {[
              { icon: FileText,    text: 'Government ID (Aadhaar, PAN, Passport, or Driving Licence)' },
              { icon: ImageIcon,   text: 'A clear selfie for face matching' },
              { icon: ShieldCheck, text: 'Secure direct-to-cloud upload — your files never touch our servers' },
            ].map(({ icon: Icon, text }) => (
              <div key={text} className="flex items-start gap-3 bg-gray-50 rounded-xl px-4 py-3">
                <Icon className="w-5 h-5 text-brand-navy/50 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-gray-600">{text}</p>
              </div>
            ))}
          </div>

          {globalErr && (
            <p className="text-sm text-rose-600 flex items-center gap-1.5">
              <AlertCircle className="w-4 h-4 flex-shrink-0" /> {globalErr}
            </p>
          )}

          <Button size="lg" onClick={handleStart} loading={creating} className="min-w-44">
            Get started
            {!creating && <ArrowRight className="w-4 h-4" />}
          </Button>
        </div>
      )}

      {/* ── Step 2: Upload ── */}
      {step === 'upload' && (
        <div className="space-y-6">
          <div className="text-center">
            <h2 className="text-xl font-bold text-gray-900">Upload Your Documents</h2>
            <p className="text-sm text-gray-500 mt-1">
              Upload at least one government ID and your selfie to continue.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {DOC_KINDS.map(kind =>
              kind === 'SELFIE' ? (
                <SelfieCaptureCard
                  key={kind}
                  state={docStates[kind]}
                  livenessResult={livenessResult ?? persistedLivenessResult(app)}
                  onOpen={() => setIsLivenessModalOpen(true)}
                />
              ) : (
                <DocUploadCard
                  key={kind}
                  kind={kind}
                  state={docStates[kind]}
                  onFile={handleFile}
                />
              ),
            )}
          </div>

          {/* Liveness verification modal */}
          <CameraModal
            isOpen={isLivenessModalOpen}
            applicationId={appId ?? ''}
            onClose={() => setIsLivenessModalOpen(false)}
            onVerified={handleLivenessVerified}
          />

          <div className="flex items-center justify-between gap-4 pt-2">
            <p className="text-sm text-gray-500">
              <span className="font-semibold text-brand-navy">{doneDocs.length}</span>
              /{DOC_KINDS.length} uploaded
              {!hasEnough && (
                <span className="text-amber-600 ml-1.5 text-xs">(Selfie + 1 ID document required)</span>
              )}
            </p>
            <Button onClick={() => setStep('submit')} disabled={!hasEnough}>
              Review &amp; Submit
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}

      {/* ── Step 3: Submit ── */}
      {step === 'submit' && (
        <div className="space-y-6">
          <div className="text-center">
            <h2 className="text-xl font-bold text-gray-900">Review &amp; Submit</h2>
            <p className="text-sm text-gray-500 mt-1">
              Confirm your documents before submitting for verification.
            </p>
          </div>

          <div className="bg-gray-50 rounded-2xl overflow-hidden divide-y divide-gray-100">
            {DOC_KINDS.map(kind => {
              const s        = docStates[kind];
              const uploaded = s.status === 'done';
              return (
                <div key={kind} className="flex items-center gap-3 px-4 py-3">
                  {uploaded
                    ? <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                    : <div className="w-4 h-4 rounded-full border-2 border-gray-300 flex-shrink-0" />
                  }
                  <span className={cn(
                    'text-sm flex-1',
                    uploaded ? 'text-gray-700 font-medium' : 'text-gray-400',
                  )}>
                    {DOC_KIND_LABEL[kind]}
                  </span>
                  {uploaded
                    ? <Badge className="bg-emerald-100 text-emerald-700" dot>Ready</Badge>
                    : <span className="text-xs text-gray-400">Not uploaded</span>
                  }
                </div>
              );
            })}
          </div>

          <div className="bg-amber-50 border border-amber-100 rounded-xl px-4 py-3 text-sm text-amber-800">
            <strong>Before you submit:</strong> ensure all images are clear, unobstructed,
            and show your current details. You cannot change documents after submission.
          </div>

          {globalErr && (
            <p className="text-sm text-rose-600 flex items-center gap-1.5">
              <AlertCircle className="w-4 h-4 flex-shrink-0" /> {globalErr}
            </p>
          )}

          <div className="flex gap-3">
            <Button variant="secondary" onClick={() => setStep('upload')} className="flex-1">
              <ArrowLeft className="w-4 h-4" />
              Back
            </Button>
            <Button onClick={handleSubmit} loading={submitting} className="flex-1">
              Submit application
              {!submitting && <ArrowRight className="w-4 h-4" />}
            </Button>
          </div>
        </div>
      )}

      {/* ── Step 4: Processing ── */}
      {step === 'processing' && (
        <ProcessingStep app={app} />
      )}

      {/* ── Step 5: Result ── */}
      {step === 'result' && app && (
        <ResultStep app={app} />
      )}
    </div>
  );
}
