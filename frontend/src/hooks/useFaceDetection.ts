'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getFaceApi } from '@/utils/faceApiLoader';
import { analyzeFacePosition, calculateEAR, calculateMAR, measureBrightness } from '@/utils/canvasUtils';
import type { FacePosition, LightingResult } from '@/types/liveness';

export interface DetectionFrame {
  faceCount:        number;
  facePosition:     FacePosition | null;
  ear:              number | null;
  mouthOpenRatio:   number | null;
  smileConfidence:  number | null;
  lighting:         LightingResult;
  timestamp:        number;
}

interface UseFaceDetectionReturn {
  latestFrame:    DetectionFrame | null;
  isDetecting:    boolean;
  startDetection: (videoEl: HTMLVideoElement, canvas: HTMLCanvasElement) => void;
  stopDetection:  () => void;
}

const MIN_FRAME_MS = 66; // ~15fps

function jitter(base: number, range: number): number {
  return base + (Math.random() - 0.5) * range;
}

export function useFaceDetection(_isSimulationMode: boolean): UseFaceDetectionReturn {
  const [latestFrame, setLatestFrame] = useState<DetectionFrame | null>(null);
  const [isDetecting, setIsDetecting] = useState(false);

  const rafRef       = useRef<number | null>(null);
  const lastFrameRef = useRef<number>(0);
  const videoRef     = useRef<HTMLVideoElement | null>(null);
  const canvasRef    = useRef<HTMLCanvasElement | null>(null);

  const stopDetection = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    setIsDetecting(false);
  }, []);

  const startDetection = useCallback((videoEl: HTMLVideoElement, canvas: HTMLCanvasElement) => {
    videoRef.current    = videoEl;
    canvasRef.current   = canvas;
    setIsDetecting(true);

    const tick = async (now: number) => {
      if (now - lastFrameRef.current < MIN_FRAME_MS) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      lastFrameRef.current = now;

      const video  = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas) { rafRef.current = requestAnimationFrame(tick); return; }

      // Always use real camera — no simulation fallback for production KYC.
      const frame = await buildRealFrame(video, canvas);

      setLatestFrame(frame);
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
  }, []);

  // Safety-net: cancel any in-flight animation frame when the hook unmounts.
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  return { latestFrame, isDetecting, startDetection, stopDetection };
}

// ── Real detection using face-api.js ─────────────────────────────────────────

async function buildRealFrame(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
): Promise<DetectionFrame> {
  const lighting  = measureBrightness(video, canvas);
  const timestamp = Date.now();

  // Video must be playing and have pixel data before we can run inference.
  if (video.readyState < 2 || video.videoWidth === 0) {
    return { faceCount: 0, facePosition: null, ear: null, mouthOpenRatio: null, smileConfidence: null, lighting, timestamp };
  }

  const faceapi = getFaceApi();
  if (!faceapi) {
    return { faceCount: 0, facePosition: null, ear: null, mouthOpenRatio: null, smileConfidence: null, lighting, timestamp };
  }

  try {
    // minConfidence 0.3 — lower threshold catches more faces in varied lighting/angles.
    const detections = await faceapi
      .detectAllFaces(video, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.3 }))
      .withFaceLandmarks()
      .withFaceExpressions();

    const faceCount = detections.length;
    if (faceCount === 0) {
      return { faceCount: 0, facePosition: null, ear: null, mouthOpenRatio: null, smileConfidence: null, lighting, timestamp };
    }

    const det     = detections[0];
    const box     = det.detection.box;
    const lm      = det.landmarks;
    const expr    = det.expressions;
    const facePos = analyzeFacePosition({ box }, video.videoWidth || canvas.width, video.videoHeight || canvas.height);

    let ear: number | null = null;
    let mar: number | null = null;
    try {
      ear = calculateEAR(lm);
      mar = calculateMAR(lm);
    } catch {
      // Landmark positions not available — skip EAR/MAR this frame.
    }

    const smileConf = (expr as Record<string, number>).happy ?? 0;

    return { faceCount, facePosition: facePos, ear, mouthOpenRatio: mar, smileConfidence: smileConf, lighting, timestamp };
  } catch (err) {
    console.warn('[VeriKYC] face-api detection error:', err);
    return { faceCount: 0, facePosition: null, ear: null, mouthOpenRatio: null, smileConfidence: null, lighting, timestamp };
  }
}

// ── Simulation mode ───────────────────────────────────────────────────────────

function buildSimulatedFrame(
  simStart: number,
  canvas: HTMLCanvasElement,
): DetectionFrame {
  const elapsed   = Date.now() - simStart;
  const timestamp = Date.now();

  const lighting: LightingResult = {
    averageBrightness: 140, isDark: false, isBright: false, isAcceptable: true,
  };

  // Phase 1 — 0–1500 ms: no face visible
  if (elapsed < 1500) {
    return { faceCount: 0, facePosition: null, ear: null, mouthOpenRatio: null, smileConfidence: null, lighting, timestamp };
  }

  // Phase 2 — 1500–4000 ms: face appearing
  if (elapsed < 4000) {
    const fp: FacePosition = { x: 0.4, y: 0.4, width: 0.20, height: 0.28, isCentered: false, isCorrectSize: false };
    return { faceCount: 1, facePosition: fp, ear: jitter(0.30, 0.04), mouthOpenRatio: 0.05, smileConfidence: 0.1, lighting, timestamp };
  }

  // Phase 3 — 4000 ms+: face in position.
  const facePos: FacePosition = {
    x: jitter(0.50, 0.04), y: jitter(0.48, 0.04),
    width: jitter(0.42, 0.02), height: jitter(0.58, 0.02),
    isCentered: true, isCorrectSize: true,
  };

  // Blink at ~3300–3500 ms
  const blinkCycle = elapsed % 3500;
  const isBlinking = blinkCycle >= 3300 && blinkCycle < 3500;
  const ear        = isBlinking ? jitter(0.13, 0.04) : jitter(0.30, 0.04);

  // Smile: ramps from 5000 ms to 0.8 by 6500 ms
  const smileConfidence = elapsed > 5000
    ? Math.min(0.1 + ((elapsed - 5000) / 1500) * 0.7, 0.8)
    : 0.1;

  // Mouth open: ramps from 8000 ms, MAR 0.05 → 0.6 over 1500 ms
  const mouthOpenRatio = elapsed > 8000
    ? Math.min(0.05 + ((elapsed - 8000) / 1500) * 0.55, 0.60)
    : 0.05;

  return {
    faceCount: 1,
    facePosition: facePos,
    ear,
    mouthOpenRatio,
    smileConfidence,
    lighting,
    timestamp,
  };
}
