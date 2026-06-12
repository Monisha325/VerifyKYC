'use client';
import { useEffect, useRef, useState } from 'react';
import { getInstructionForStep } from '@/utils/livenessHelpers';
import type { LivenessStep } from '@/types/liveness';

interface Props {
  step:             LivenessStep;
  isSimulationMode: boolean;
}

export default function LivenessInstructions({ step, isSimulationMode }: Props) {
  const { title, subtitle, icon } = getInstructionForStep(step);
  const [visible, setVisible] = useState(true);
  const prevStep = useRef(step);

  useEffect(() => {
    if (prevStep.current === step) return;
    prevStep.current = step;
    setVisible(false);
    const t = setTimeout(() => setVisible(true), 120);
    return () => clearTimeout(t);
  }, [step]);

  const isActive = ['detecting_face','face_not_centered','face_too_far','face_too_close','challenge_blink','challenge_nod','challenge_smile'].includes(step);

  return (
    <>
      <style>{`
        @keyframes fadeSlideUp {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes dotPulse {
          0%,100% { opacity:1; transform:scale(1); }
          50% { opacity:0.4; transform:scale(0.7); }
        }
        .instr-fade { animation: fadeSlideUp 0.2s ease forwards; }
        .dot-pulse  { animation: dotPulse 1.2s ease-in-out infinite; }
      `}</style>
      <div
        className={`flex flex-col items-center gap-1 text-center px-4 py-3 ${visible ? 'instr-fade' : 'opacity-0'}`}
        aria-live="polite"
        aria-atomic="true"
      >
        <div className="flex items-center gap-2">
          <span className="text-xl leading-none">{icon}</span>
          <span className="text-sm font-semibold text-white drop-shadow">{title}</span>
          {isActive && (
            <span className="dot-pulse inline-block w-2 h-2 rounded-full bg-green-400 flex-shrink-0" />
          )}
        </div>
        <p className="text-xs text-white/70 leading-snug max-w-[220px]">{subtitle}</p>
        {isSimulationMode && (
          <span className="mt-1 text-[10px] bg-amber-500/20 text-amber-300 px-2 py-0.5 rounded-full font-medium">
            Demo mode
          </span>
        )}
      </div>
    </>
  );
}
