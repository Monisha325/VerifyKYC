'use client';
import type { LivenessStep, FacePosition } from '@/types/liveness';

interface Props {
  step:         LivenessStep;
  confidence:   number;
  facePosition: FacePosition | null;
}

// SVG viewBox 100×100. Oval centred at (50,50), rx=27.5, ry=36
const CX = 50, CY = 50, RX = 27.5, RY = 36;
// Ramanujan approximation of ellipse circumference
const h   = ((RX - RY) / (RX + RY)) ** 2;
const CIRC = Math.PI * (RX + RY) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));

function strokeColor(step: LivenessStep, facePosition: FacePosition | null): string {
  const errorSteps: LivenessStep[] = ['face_too_far', 'face_too_close', 'lighting_too_dark', 'lighting_too_bright', 'multiple_faces', 'failed', 'timeout'];
  if (errorSteps.includes(step)) return '#ef4444';
  if (step === 'verified') return '#10b981';
  if (step === 'face_not_centered') return '#f59e0b';
  if (facePosition?.isCentered) return '#10b981';
  return '#94a3b8';
}

function isDashed(step: LivenessStep, confidence: number): boolean {
  if (step === 'verified') return false;
  return confidence < 100;
}

function isError(step: LivenessStep): boolean {
  return ['face_too_far','face_too_close','lighting_too_dark','lighting_too_bright','multiple_faces','failed','timeout'].includes(step);
}

const CORNER_LEN = 5;
const CORNER_OFFSET = 3;

function cornerPath(corner: 'tl'|'tr'|'bl'|'br'): string {
  // Approximate bounding box of the oval is [CX-RX, CY-RY] to [CX+RX, CY+RY]
  const left  = CX - RX - CORNER_OFFSET;
  const right = CX + RX + CORNER_OFFSET;
  const top   = CY - RY - CORNER_OFFSET;
  const bot   = CY + RY + CORNER_OFFSET;

  switch (corner) {
    case 'tl': return `M ${left + CORNER_LEN},${top} L ${left},${top} L ${left},${top + CORNER_LEN}`;
    case 'tr': return `M ${right - CORNER_LEN},${top} L ${right},${top} L ${right},${top + CORNER_LEN}`;
    case 'bl': return `M ${left + CORNER_LEN},${bot} L ${left},${bot} L ${left},${bot - CORNER_LEN}`;
    case 'br': return `M ${right - CORNER_LEN},${bot} L ${right},${bot} L ${right},${bot - CORNER_LEN}`;
  }
}

export default function FaceOvalOverlay({ step, confidence, facePosition }: Props) {
  const color     = strokeColor(step, facePosition);
  const dashed    = isDashed(step, confidence);
  const error     = isError(step);
  const dashOffset = CIRC * (1 - Math.min(confidence, 100) / 100);
  const cornerColor = facePosition?.isCentered ? '#10b981' : '#94a3b8';

  return (
    <>
      <style>{`
        @keyframes ovalPulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        .oval-error { animation: ovalPulse 1s ease-in-out infinite; }
      `}</style>
      <svg
        viewBox="0 0 100 100"
        className="absolute inset-0 w-full h-full pointer-events-none"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Dim overlay outside the oval */}
        <defs>
          <mask id="ovalCutout">
            <rect width="100" height="100" fill="white" />
            <ellipse cx={CX} cy={CY} rx={RX} ry={RY} fill="black" />
          </mask>
        </defs>
        <rect width="100" height="100" fill="rgba(0,0,0,0.55)" mask="url(#ovalCutout)" />

        {/* Oval stroke */}
        <ellipse
          cx={CX} cy={CY} rx={RX} ry={RY}
          fill="none"
          stroke={color}
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeDasharray={dashed ? '4 2' : `${CIRC}`}
          strokeDashoffset={dashed ? undefined : dashOffset}
          transform={`rotate(-90 ${CX} ${CY})`}
          className={error ? 'oval-error' : undefined}
          style={{ transition: 'stroke 0.3s ease, stroke-dashoffset 0.4s ease' }}
        />

        {/* Corner guides */}
        {(['tl','tr','bl','br'] as const).map(corner => (
          <path
            key={corner}
            d={cornerPath(corner)}
            stroke={cornerColor}
            strokeWidth="1.5"
            fill="none"
            strokeLinecap="round"
            style={{ transition: 'stroke 0.3s ease' }}
          />
        ))}
      </svg>
    </>
  );
}
