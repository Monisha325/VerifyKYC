'use client';

export default function ScanningOverlay({ isActive }: { isActive: boolean }) {
  if (!isActive) return null;

  return (
    <>
      <style>{`
        @keyframes scanLine {
          0%   { transform: translateY(-100%); opacity: 0; }
          10%  { opacity: 1; }
          90%  { opacity: 1; }
          100% { transform: translateY(100%); opacity: 0; }
        }
        .scan-line { animation: scanLine 2s linear infinite; }
      `}</style>
      <div className="absolute inset-0 pointer-events-none overflow-hidden rounded-2xl">
        <div
          className="scan-line absolute left-0 right-0"
          style={{
            top:        0,
            height:    '3px',
            background:'linear-gradient(to right, transparent 0%, rgba(255,255,255,0.8) 40%, rgba(255,255,255,0.8) 60%, transparent 100%)',
            mixBlendMode: 'overlay',
          }}
        />
      </div>
    </>
  );
}
