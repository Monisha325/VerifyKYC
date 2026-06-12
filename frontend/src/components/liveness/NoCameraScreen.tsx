'use client';
import { useRef } from 'react';

interface Props { onFileSelected: (file: File) => void }

export default function NoCameraScreen({ onFileSelected }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) onFileSelected(file);
    e.target.value = '';
  }

  return (
    <div className="flex flex-col items-center gap-5 py-4 text-center">
      <div className="text-5xl">📷</div>
      <div>
        <p className="text-white font-semibold">No Camera Detected</p>
        <p className="text-white/60 text-xs mt-1 max-w-xs leading-relaxed">
          Liveness check requires a camera. If you&apos;re on a desktop, please connect a webcam and refresh the page.
        </p>
      </div>

      <div className="w-full max-w-xs bg-white/5 border border-white/10 rounded-xl px-4 py-3">
        <p className="text-xs text-white/50 font-medium mb-2">Don&apos;t have a webcam?</p>
        <p className="text-xs text-white/40 mb-3 leading-relaxed">
          You can upload a clear, well-lit selfie photo as a fallback. Our team will manually verify it.
        </p>
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={handleChange}
        />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="w-full py-2 text-xs font-semibold text-white/80 border border-white/20 rounded-lg hover:bg-white/10 transition-colors"
        >
          Upload Selfie Instead
        </button>
      </div>
    </div>
  );
}
