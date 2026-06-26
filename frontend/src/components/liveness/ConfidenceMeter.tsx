'use client';
import type { LivenessStep } from '@/lib/types';

interface Props { confidence: number; step: LivenessStep }

const HIDDEN_STEPS: LivenessStep[] = ['idle','requesting_permission','permission_denied','no_camera','camera_starting','failed','timeout'];

export default function ConfidenceMeter({ confidence, step }: Props) {
  if (HIDDEN_STEPS.includes(step)) return null;

  const pct = Math.max(0, Math.min(100, confidence));

  return (
    <div className="w-full px-4 pb-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] text-white/50 font-medium uppercase tracking-wider">Confidence</span>
        <span className="text-[10px] text-white/70 font-bold tabular-nums">{Math.round(pct)}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
        <div
          className="h-full rounded-full"
          style={{
            width:      `${pct}%`,
            background: `linear-gradient(to right, #f59e0b, #10b981)`,
            transition: 'width 0.4s ease',
          }}
        />
      </div>
    </div>
  );
}
