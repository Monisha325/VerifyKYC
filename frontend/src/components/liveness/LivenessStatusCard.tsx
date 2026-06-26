'use client';
import type { LivenessVerificationResult } from '@/lib/types';

interface Props {
  result:   LivenessVerificationResult | null;
  onRetry:  () => void;
}

function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  } catch { return iso; }
}

export default function LivenessStatusCard({ result, onRetry }: Props) {
  if (!result) {
    // Pending state
    return (
      <div className="rounded-2xl border border-gray-200 bg-white p-5">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-gray-100 animate-pulse" />
          <div className="flex-1 space-y-2">
            <div className="h-3 bg-gray-100 rounded animate-pulse w-32" />
            <div className="h-2 bg-gray-100 rounded animate-pulse w-20" />
          </div>
          <div className="h-5 w-16 bg-gray-100 rounded-full animate-pulse" />
        </div>
        <p className="text-xs text-gray-400">Liveness verification not yet completed.</p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 text-xs font-semibold text-brand-navy hover:underline"
        >
          Complete Verification →
        </button>
      </div>
    );
  }

  const isVerified = result.status === 'verified';

  return (
    <div className={`rounded-2xl border p-5 ${isVerified ? 'border-emerald-200 bg-emerald-50/40' : 'border-rose-200 bg-rose-50/30'}`}>
      <div className="flex items-start gap-3">
        {/* Blurred face thumbnail */}
        {result.capturedImageDataURL && (
          <div className="flex-shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={result.capturedImageDataURL}
              alt="Captured face"
              className="w-14 h-14 rounded-full object-cover scale-x-[-1]"
              style={{ filter: 'blur(4px)' }}
            />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className={`text-sm font-semibold ${isVerified ? 'text-emerald-700' : 'text-rose-700'}`}>
              {isVerified ? 'Liveness Verified' : 'Verification Failed'}
            </span>
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${isVerified ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>
              {isVerified ? 'PASSED' : 'FAILED'}
            </span>
          </div>

          {isVerified && (
            <div className="flex items-center gap-3 text-xs text-gray-500">
              <span>Score: <strong className="text-emerald-600">{result.confidence.toFixed(1)}%</strong></span>
              {result.challenges.length > 0 && (
                <>
                  <span>·</span>
                  <span>{result.challenges.length} challenge{result.challenges.length !== 1 ? 's' : ''} passed</span>
                </>
              )}
            </div>
          )}

          {!isVerified && result.failureReason && (
            <p className="text-xs text-rose-600 mt-0.5">{result.failureReason}</p>
          )}

          <p className="text-[10px] text-gray-400 mt-1">
            {formatDate(result.verifiedAt)}
          </p>
        </div>
      </div>

      {!isVerified && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 text-xs font-semibold text-rose-600 hover:underline"
        >
          Retry Verification →
        </button>
      )}
    </div>
  );
}
