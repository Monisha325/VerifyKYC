'use client';

interface Props {
  dataURL:    string;
  confidence: number;
  onConfirm:  () => void;
  onRetake:   () => void;
}

export default function CapturePreview({ dataURL, confidence, onConfirm, onRetake }: Props) {
  return (
    <>
      <style>{`
        @keyframes scaleIn {
          from { opacity:0; transform:scale(0.9); }
          to   { opacity:1; transform:scale(1); }
        }
        .preview-enter { animation: scaleIn 0.25s ease forwards; }
      `}</style>
      <div className="flex flex-col items-center gap-5 py-4 preview-enter">
        <p className="text-white font-semibold text-sm">Review Your Photo</p>

        <div className="relative">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={dataURL}
            alt="Captured selfie"
            className="w-48 h-48 rounded-full object-cover border-4 border-white/20 scale-x-[-1]"
          />
          <div className="absolute -bottom-3 left-1/2 -translate-x-1/2 bg-emerald-500 text-white text-[10px] font-bold px-3 py-1 rounded-full whitespace-nowrap shadow">
            Liveness Score: {confidence.toFixed(1)}%
          </div>
        </div>

        <div className="flex gap-3 mt-2">
          <button
            type="button"
            onClick={onRetake}
            className="px-4 py-2 text-sm font-medium text-white/80 border border-white/20 rounded-xl hover:bg-white/10 transition-colors"
          >
            Retake
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="px-5 py-2 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-500 rounded-xl transition-colors shadow"
          >
            Use this photo
          </button>
        </div>
      </div>
    </>
  );
}
