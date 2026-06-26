'use client';
import { getCameraPermissionInstructions } from '@/lib/livenessHelpers';

interface Props { onRetry: () => void }

export default function PermissionErrorScreen({ onRetry }: Props) {
  const { browser, steps } = getCameraPermissionInstructions();

  return (
    <div className="flex flex-col items-center gap-5 py-4 text-center">
      <div className="text-5xl">🚫</div>
      <div>
        <p className="text-white font-semibold">Camera Access Denied</p>
        <p className="text-white/60 text-xs mt-1 max-w-xs leading-relaxed">
          Liveness verification requires camera access. Here&apos;s how to enable it in <strong>{browser}</strong>:
        </p>
      </div>

      <ol className="text-left space-y-2 w-full max-w-xs">
        {steps.map((step, i) => (
          <li key={i} className="flex gap-2.5 text-xs text-white/70">
            <span className="w-5 h-5 rounded-full bg-white/10 flex items-center justify-center flex-shrink-0 font-bold text-white/50 text-[10px]">
              {i + 1}
            </span>
            {step}
          </li>
        ))}
      </ol>

      <button
        type="button"
        onClick={onRetry}
        className="mt-2 px-5 py-2.5 text-sm font-semibold text-white bg-brand-navy/80 hover:bg-brand-navy rounded-xl transition-colors"
      >
        Try Again
      </button>
    </div>
  );
}
