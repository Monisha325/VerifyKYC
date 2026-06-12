'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

interface UseCameraReturn {
  videoRef:    React.RefObject<HTMLVideoElement>;
  canvasRef:   React.RefObject<HTMLCanvasElement>;
  stream:      MediaStream | null;
  isReady:     boolean;
  error:       'permission_denied' | 'no_camera' | 'unknown' | null;
  startCamera: () => Promise<void>;
  stopCamera:  () => void;
}

const IDEAL_CONSTRAINTS: MediaStreamConstraints = {
  video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user', frameRate: { ideal: 30 } },
  audio: false,
};
const FALLBACK_CONSTRAINTS: MediaStreamConstraints = {
  video: { facingMode: 'user' },
  audio: false,
};

export function useCamera(): UseCameraReturn {
  const videoRef   = useRef<HTMLVideoElement>(null!);
  const canvasRef  = useRef<HTMLCanvasElement>(null!);
  // streamRef gives stopCamera() synchronous access to the live stream object,
  // avoiding the stale-closure problem of reading stream state inside a callback.
  const streamRef  = useRef<MediaStream | null>(null);

  const [stream,  setStream]  = useState<MediaStream | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [error,   setError]   = useState<'permission_denied' | 'no_camera' | 'unknown' | null>(null);

  const stopCamera = useCallback(() => {
    // Stop tracks immediately and synchronously via the ref — never via state.
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    // Clear srcObject before resetting state so the browser releases the device.
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setStream(null);
    setIsReady(false);
  }, []);

  const attachStream = useCallback((ms: MediaStream) => {
    const video = videoRef.current;
    if (!video) return;

    // iOS Safari requirements
    video.setAttribute('playsinline', '');
    video.setAttribute('muted', '');
    video.playsInline = true;
    video.muted = true;

    streamRef.current = ms;
    video.srcObject   = ms;
    setStream(ms);

    const onLoaded = () => {
      setIsReady(true);
      video.play().catch(() => { /* autoplay policy — user interaction required */ });
    };

    if (video.readyState >= 1) {
      onLoaded();
    } else {
      video.addEventListener('loadedmetadata', onLoaded, { once: true });
    }
  }, []);

  const startCamera = useCallback(async () => {
    setError(null);
    setIsReady(false);

    try {
      const ms = await navigator.mediaDevices.getUserMedia(IDEAL_CONSTRAINTS);
      attachStream(ms);
    } catch (err) {
      const name = (err as { name?: string }).name ?? '';

      if (name === 'OverconstrainedError') {
        try {
          const ms = await navigator.mediaDevices.getUserMedia(FALLBACK_CONSTRAINTS);
          attachStream(ms);
          return;
        } catch {
          setError('unknown');
          return;
        }
      }

      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setError('permission_denied');
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        setError('no_camera');
      } else {
        setError('unknown');
      }
    }
  }, [attachStream]);

  // Safety-net: stop the stream when the hook's owner unmounts.
  useEffect(() => () => { stopCamera(); }, [stopCamera]);

  return { videoRef, canvasRef, stream, isReady, error, startCamera, stopCamera };
}
