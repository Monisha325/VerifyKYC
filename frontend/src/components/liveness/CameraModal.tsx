'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Loader2, CheckCircle2, RefreshCw } from 'lucide-react';
import type { LivenessVerificationResult } from '@/types/liveness';

// ── Landmark indices (MediaPipe FaceMesh 468-point model) ────────────────────
const LEFT_EYE_IDX  = [33, 160, 158, 133, 153, 144] as const;
const RIGHT_EYE_IDX = [362, 385, 387, 263, 373, 380] as const;
const LEFT_CHEEK  = 234;
const RIGHT_CHEEK = 454;
const NOSE_TIP    = 1;

// ── Constants ─────────────────────────────────────────────────────────────────
const CALIB_TARGET         = 60;    // valid EAR frames for baseline
const CLOSE_RATIO          = 0.82;  // EAR below baseline × this = eyes closed
const MIN_CLOSED           = 2;     // min consecutive closed frames (~60ms)
const MIN_OPEN_AFT         = 2;     // consecutive open frames after close
const CHALLENGE_GAP_S      = 4;     // seconds between challenges
const CHALLENGE_TIME_LIMIT = 20;    // seconds per challenge before retry button
const HEAD_TURN_THRESHOLD  = 0.13;  // fraction of face width off-center for a head turn
const HEAD_CONSEC          = 6;     // consecutive frames required to confirm head turn

const CHALLENGE_LABELS: Partial<Record<Phase, string>> = {
  blink:      'Blink',
  head_left:  'Turn Head Left',
  head_right: 'Turn Head Right',
};

type Phase =
  | 'idle' | 'starting' | 'calibrating' | 'face'
  | 'blink' | 'head_left' | 'head_right' | 'capturing' | 'done' | 'error';

interface Props {
  isOpen:     boolean;
  onClose:    () => void;
  onVerified: (result: LivenessVerificationResult) => void;
}

// ── Math helpers ──────────────────────────────────────────────────────────────
type P2 = { x: number; y: number };
const d2 = (a: P2, b: P2) => Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);

function euclidean(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

// EAR on raw normalized [0,1] coords — ratio is scale-invariant
function computeEAR(
  lm: { x: number; y: number; z: number }[],
  idx: readonly number[],
): number {
  const p = (i: number) => lm[idx[i]];
  const vert1 = euclidean(p(1), p(5));
  const vert2 = euclidean(p(2), p(4));
  const horiz = euclidean(p(0), p(3));
  return horiz < 0.0001 ? 0 : (vert1 + vert2) / (2.0 * horiz);
}

// Head yaw: positive = nose moved right in raw image = user turned THEIR left
// (canvas is rendered scale-x-[-1], so this looks correct in the mirror view)
function computeHeadYaw(lm: P2[]): number {
  const faceW = d2(lm[LEFT_CHEEK], lm[RIGHT_CHEEK]);
  if (faceW < 0.0001) return 0;
  const cx = (lm[LEFT_CHEEK].x + lm[RIGHT_CHEEK].x) / 2;
  return (lm[NOSE_TIP].x - cx) / faceW;
}

function captureFrame(video: HTMLVideoElement): string {
  if (!video.srcObject || video.readyState < 2 || video.videoWidth === 0) return '';
  const w = Math.max(video.videoWidth,  640);
  const h = Math.max(video.videoHeight, 480);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(video, 0, 0, w, h);
  const sample = ctx.getImageData(w >> 1, h >> 1, 1, 1).data;
  if (sample[3] === 0 || (sample[0] === 0 && sample[1] === 0 && sample[2] === 0)) return '';
  return c.toDataURL('image/jpeg', 0.95);
}

function dataURLtoBlob(dataURL: string): Blob {
  const [hdr, raw] = dataURL.split(',');
  const mime = hdr.match(/:(.*?);/)![1];
  const bin  = atob(raw);
  const arr  = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// ── getCamera — getUserMedia with 8s timeout ──────────────────────────────────
async function getCamera(): Promise<MediaStream> {
  return Promise.race([
    navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user',
        width:      { ideal: 640 },
        height:     { ideal: 480 },
        frameRate:  { ideal: 30, max: 30 },
      },
      audio: false,
    }),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(Object.assign(new Error('Camera took too long — click Try Again to retry.'), { name: 'TimeoutError' })),
        8000,
      )
    ),
  ]);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FaceMeshAny = any;

// ── Component ─────────────────────────────────────────────────────────────────
export default function CameraModal({ isOpen, onClose, onVerified }: Props) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [modelReady,        setModelReady]        = useState(false);
  const [modelErr,          setModelErr]          = useState(false);
  const [modelLoadKey,      setModelLoadKey]      = useState(0);
  const modelErrRef         = useRef(false);
  const [phase,             setPhase]             = useState<Phase>('idle');
  const [score,             setScore]             = useState(0);
  const [calPct,            setCalPct]            = useState(0);
  const [noFace,            setNoFace]            = useState(false);
  const [errMsg,            setErrMsg]            = useState('');
  const [countdown,         setCountdown]         = useState<number | null>(null);
  const [transitionMsg,     setTransitionMsg]     = useState('');
  const [challengeTimeLeft, setChallengeTimeLeft] = useState<number | null>(null);
  const [showRetry,         setShowRetry]         = useState(false);

  // ── Refs ──────────────────────────────────────────────────────────────────
  const videoRef          = useRef<HTMLVideoElement>(null);
  const canvasRef         = useRef<HTMLCanvasElement>(null);
  const streamRef         = useRef<MediaStream | null>(null);
  const fmRef             = useRef<FaceMeshAny>(null);
  const rafRef            = useRef<number | null>(null);
  const activeRef         = useRef(false);
  const abortRef          = useRef(false);
  const sendingRef        = useRef(false);
  const sessionRef        = useRef(0);
  const phaseRef          = useRef<Phase>('idle');
  const snapsRef          = useRef<string[]>([]);

  // Transition control — blocks onResults during countdowns between challenges
  const transitioningRef  = useRef(false);
  const challengeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Mirrors modelReady state — readable synchronously inside async functions
  const modelReadyRef     = useRef(false);

  // Callback refs — always point to latest fn so onResults can call them safely
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onResultsRef       = useRef<((r: any) => void) | null>(null);
  const beginTransitionRef = useRef<((snapIdx: number, next: Phase, nextScore: number) => void) | null>(null);
  const startTimerRef      = useRef<((p: Phase) => void) | null>(null);

  // Calibration accumulators
  const calibSamplesRef = useRef<number[]>([]);
  const calYawRef       = useRef(0);
  const earBaselineRef  = useRef(0.28);

  // Per-person baselines (set after calibration, never reset between challenges)
  const baseRef = useRef({ ear: 0, yaw: 0 });

  // Actual wall-clock timestamps for each completed challenge
  const challengeTimestampsRef = useRef<Partial<Record<Phase, number>>>({});

  // One-shot flags
  const faceDoneRef      = useRef(false);
  const blinkDoneRef     = useRef(false);
  const headLeftOkRef    = useRef(false);
  const headRightOkRef   = useRef(false);

  // Blink state machine
  const blinkEyesClosedRef  = useRef(false);
  const blinkClosedCountRef = useRef(0);
  const blinkOpenCountRef   = useRef(0);
  const blinkLastEARRef     = useRef(0);

  // Consecutive counters for head turns
  const headLeftConsecRef  = useRef(0);
  const headRightConsecRef = useRef(0);

  // ── go ───────────────────────────────────────────────────────────────────
  const go = useCallback((next: Phase, nextScore?: number) => {
    phaseRef.current = next;
    setPhase(next);
    if (nextScore !== undefined) setScore(nextScore);
  }, []);

  // ── startChallengeTimer — counts down, shows retry on timeout ─────────────
  const startChallengeTimer = useCallback((challengePhase: Phase) => {
    if (challengeTimerRef.current !== null) {
      clearInterval(challengeTimerRef.current);
      challengeTimerRef.current = null;
    }
    let remaining = CHALLENGE_TIME_LIMIT;
    setChallengeTimeLeft(remaining);
    challengeTimerRef.current = setInterval(() => {
      remaining--;
      setChallengeTimeLeft(remaining);
      if (remaining <= 0) {
        clearInterval(challengeTimerRef.current!);
        challengeTimerRef.current = null;
        setChallengeTimeLeft(null);
        if (phaseRef.current === challengePhase) {
          setShowRetry(true);
        }
      }
    }, 1000);
  }, []);

  // Keep startTimerRef current each render
  startTimerRef.current = startChallengeTimer;

  // ── beginTransition — countdown between challenges ────────────────────────
  const beginTransition = useCallback(async (
    snapIdx: number,
    next: Phase,
    nextScore: number,
  ) => {
    if (transitioningRef.current) return;
    transitioningRef.current = true;

    if (challengeTimerRef.current !== null) {
      clearInterval(challengeTimerRef.current);
      challengeTimerRef.current = null;
    }
    setChallengeTimeLeft(null);
    setShowRetry(false);

    const confirmedAt = Date.now();
    challengeTimestampsRef.current[phaseRef.current] = confirmedAt;
    const timeStr = new Date(confirmedAt).toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });

    const video = videoRef.current;
    if (video) snapsRef.current[snapIdx] = captureFrame(video);
    setScore(nextScore);

    const currentLabel = CHALLENGE_LABELS[phaseRef.current] ?? String(phaseRef.current);
    const nextLabel    = CHALLENGE_LABELS[next]             ?? String(next);

    for (let i = CHALLENGE_GAP_S; i >= 1; i--) {
      setCountdown(i);
      setTransitionMsg(
        i > 3
          ? `✅ ${currentLabel} at ${timeStr} — ${nextLabel} in ${i}s`
          : `Get ready to ${nextLabel}… ${i}`,
      );
      await new Promise<void>(r => setTimeout(r, 1000));
      if (!activeRef.current) {
        transitioningRef.current = false;
        setCountdown(null);
        setTransitionMsg('');
        return;
      }
    }
    setCountdown(null);
    setTransitionMsg('');

    // Reset per-challenge detection state — DO NOT reset baselines
    blinkEyesClosedRef.current  = false;
    blinkClosedCountRef.current = 0;
    blinkOpenCountRef.current   = 0;
    headLeftConsecRef.current   = 0;
    headRightConsecRef.current  = 0;

    phaseRef.current = next;
    setPhase(next);
    transitioningRef.current = false;

    startTimerRef.current?.(next);
  }, []);

  // Keep beginTransitionRef current each render
  beginTransitionRef.current = beginTransition;

  // ── onResults — called by FaceMesh for every frame ───────────────────────
  const onResults = useCallback((results: {
    multiFaceLandmarks?: Array<Array<{ x: number; y: number; z: number }>>;
  }) => {
    if (transitioningRef.current) return;
    if (!activeRef.current) return;
    const video  = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    canvas.width  = video.videoWidth  || 640;
    canvas.height = video.videoHeight || 480;

    // raw = normalized [0,1] coords for EAR (scale-invariant)
    const raw = results.multiFaceLandmarks?.[0];
    if (raw && raw.length < 468) {
      console.warn('[liveness] unexpected landmark count:', raw.length);
      return;
    }

    // lm = pixel-space coords for drawing + yaw
    const lm = raw
      ? raw.map(p => ({ x: p.x * canvas.width, y: p.y * canvas.height }))
      : null;

    setNoFace(!lm);

    const phase = phaseRef.current;

    if (!lm || !raw) {
      if (phase === 'calibrating') {
        calibSamplesRef.current = [];
        calYawRef.current       = 0;
        setCalPct(0);
      }
      return;
    }

    // ── Per-frame metrics ─────────────────────────────────────────────────
    const leftEAR  = computeEAR(raw, LEFT_EYE_IDX);
    const rightEAR = computeEAR(raw, RIGHT_EYE_IDX);
    const avgEAR   = (leftEAR + rightEAR) / 2;
    const yaw      = computeHeadYaw(lm);

    // ── CALIBRATING ───────────────────────────────────────────────────────
    if (phase === 'calibrating') {
      if (avgEAR >= 0.18 && avgEAR <= 0.45) {
        calibSamplesRef.current.push(avgEAR);
        calYawRef.current += yaw;
      }

      const pct = Math.round((calibSamplesRef.current.length / CALIB_TARGET) * 100);
      setCalPct(Math.min(pct, 100));

      if (calibSamplesRef.current.length >= CALIB_TARGET) {
        const n      = calibSamplesRef.current.length;
        const sorted = [...calibSamplesRef.current].sort((a, b) => a - b);
        const p80    = sorted[Math.floor(n * 0.80)];
        earBaselineRef.current = p80;
        baseRef.current = {
          ear: p80,
          yaw: calYawRef.current / n,
        };
        console.log(
          `[calibration] EAR p80=${p80.toFixed(4)} yawBase=${baseRef.current.yaw.toFixed(4)}`,
        );
        phaseRef.current = 'face';
        setPhase('face');
      }
      return;
    }

    // ── FACE — capture neutral snap then transition to blink ──────────────
    if (phase === 'face') {
      if (!faceDoneRef.current) {
        faceDoneRef.current = true;
        beginTransitionRef.current?.(0, 'blink', 25);
      }
      return;
    }

    const eB  = earBaselineRef.current;
    const bY  = baseRef.current.yaw;

    // ── BLINK ─────────────────────────────────────────────────────────────
    if (phase === 'blink' && !blinkDoneRef.current) {
      const threshold   = eB * CLOSE_RATIO;
      const leftClosed  = leftEAR  < threshold;
      const rightClosed = rightEAR < threshold;
      const eyesClosed  = leftClosed || rightClosed;

      blinkLastEARRef.current = avgEAR;

      console.log(
        `[blink] avg=${avgEAR.toFixed(4)} L=${leftEAR.toFixed(4)} R=${rightEAR.toFixed(4)}` +
        ` thr=${threshold.toFixed(4)} closed=${eyesClosed}` +
        ` closedCount=${blinkClosedCountRef.current} openCount=${blinkOpenCountRef.current}`,
      );

      if (eyesClosed) {
        blinkEyesClosedRef.current = true;
        blinkClosedCountRef.current++;
        blinkOpenCountRef.current = 0;
      } else {
        if (blinkEyesClosedRef.current) {
          if (blinkClosedCountRef.current >= MIN_CLOSED) {
            blinkOpenCountRef.current++;
            if (blinkOpenCountRef.current >= MIN_OPEN_AFT) {
              blinkDoneRef.current        = true;
              blinkEyesClosedRef.current  = false;
              blinkClosedCountRef.current = 0;
              blinkOpenCountRef.current   = 0;
              beginTransitionRef.current?.(1, 'head_left', 50);
            }
          } else {
            // Single-frame noise — discard
            blinkEyesClosedRef.current  = false;
            blinkClosedCountRef.current = 0;
            blinkOpenCountRef.current   = 0;
          }
        }
      }

      return;
    }

    // ── HEAD LEFT ─────────────────────────────────────────────────────────
    // Positive yaw (nose right in raw image) = user turned THEIR left
    if (phase === 'head_left' && !headLeftOkRef.current) {
      const relYaw  = yaw - bY;
      const turned  = relYaw > HEAD_TURN_THRESHOLD;
      headLeftConsecRef.current = turned ? headLeftConsecRef.current + 1 : 0;

      console.log(`[head_left] yaw=${yaw.toFixed(4)} rel=${relYaw.toFixed(4)} thr=${HEAD_TURN_THRESHOLD} consec=${headLeftConsecRef.current}`);

      if (headLeftConsecRef.current >= HEAD_CONSEC) {
        headLeftOkRef.current        = true;
        headLeftConsecRef.current    = 0;
        beginTransitionRef.current?.(2, 'head_right', 75);
      }

      return;
    }

    // ── HEAD RIGHT ────────────────────────────────────────────────────────
    // Negative yaw (nose left in raw image) = user turned THEIR right
    if (phase === 'head_right' && !headRightOkRef.current) {
      const relYaw  = yaw - bY;
      const turned  = relYaw < -HEAD_TURN_THRESHOLD;
      headRightConsecRef.current = turned ? headRightConsecRef.current + 1 : 0;

      console.log(`[head_right] yaw=${yaw.toFixed(4)} rel=${relYaw.toFixed(4)} thr=${-HEAD_TURN_THRESHOLD} consec=${headRightConsecRef.current}`);

      if (headRightConsecRef.current >= HEAD_CONSEC) {
        headRightOkRef.current          = true;
        headRightConsecRef.current      = 0;
        challengeTimestampsRef.current['head_right'] = Date.now();
        snapsRef.current[3]             = captureFrame(video);
        go('capturing', 100);
      }

    }
  }, [go]);

  // Keep onResultsRef current each render
  onResultsRef.current = onResults;

  // ── Load FaceMesh ─────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    if (fmRef.current) { fmRef.current.close().catch(() => {}); fmRef.current = null; }

    const load = async () => {
      try {
        console.log('[liveness] Loading FaceMesh from local assets…');
        const { FaceMesh } = await import('@mediapipe/face_mesh');
        if (cancelled) return;
        const fm = new FaceMesh({
          locateFile: (f: string) => `/mediapipe/face_mesh/${f}`,
        });
        fm.setOptions({
          maxNumFaces:            1,
          refineLandmarks:        false,
          minDetectionConfidence: 0.60,
          minTrackingConfidence:  0.60,
        });
        fm.onResults((r: unknown) => onResultsRef.current?.(r));
        await Promise.race([
          fm.initialize(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('FaceMesh initialize timed out after 30 s')), 30_000),
          ),
        ]);
        if (cancelled) { fm.close().catch(() => {}); return; }
        fmRef.current = fm;
        modelReadyRef.current = true;
        setModelReady(true);
        console.log('[liveness] FaceMesh ready');
      } catch (err) {
        if (cancelled) return;
        console.error('[liveness] FaceMesh load failed:', err);
        modelErrRef.current = true;
        setModelErr(true);
      }
    };

    load();

    return () => {
      cancelled = true;
      fmRef.current?.close().catch(() => {});
      fmRef.current = null;
    };
  }, [modelLoadKey]);

  // ── stop — modal-close cleanup; does NOT close FaceMesh (preloaded) ────────
  const stop = useCallback(() => {
    abortRef.current         = true;
    activeRef.current        = false;
    transitioningRef.current = false;
    if (challengeTimerRef.current !== null) {
      clearInterval(challengeTimerRef.current);
      challengeTimerRef.current = null;
    }
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    const video = videoRef.current;
    if (video) { video.pause(); video.srcObject = null; }
  }, []);

  // ── fullReset — retry-path cleanup with hardware-release wait ─────────────
  const fullReset = useCallback(async () => {
    console.log('[reset] starting...');
    abortRef.current         = true;
    activeRef.current        = false;
    transitioningRef.current = false;
    if (challengeTimerRef.current !== null) {
      clearInterval(challengeTimerRef.current);
      challengeTimerRef.current = null;
    }
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => {
        track.stop();
        console.log('[reset] track stopped:', track.label);
      });
      streamRef.current = null;
    }

    const video = videoRef.current;
    if (video?.srcObject) {
      (video.srcObject as MediaStream).getTracks().forEach(track => {
        track.stop();
        console.log('[reset] track stopped (srcObject):', track.label);
      });
    }

    if (video) {
      video.pause();
      video.srcObject = null;
      video.load();
    }

    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    }

    console.log('[reset] waiting for hardware release...');
    await new Promise<void>(r => setTimeout(r, 1000));
    console.log('[reset] hardware released');
  }, []);

  // ── resetRefs ────────────────────────────────────────────────────────────
  const resetRefs = useCallback(() => {
    calibSamplesRef.current      = [];
    calYawRef.current            = 0;
    earBaselineRef.current       = 0.28;
    baseRef.current              = { ear: 0, yaw: 0 };
    faceDoneRef.current          = false;
    blinkDoneRef.current         = false;
    headLeftOkRef.current        = false;
    headRightOkRef.current       = false;
    blinkEyesClosedRef.current   = false;
    blinkClosedCountRef.current  = 0;
    blinkOpenCountRef.current    = 0;
    blinkLastEARRef.current      = 0;
    snapsRef.current             = [];
    headLeftConsecRef.current    = 0;
    headRightConsecRef.current   = 0;
    transitioningRef.current     = false;
    challengeTimestampsRef.current = {};
    setShowRetry(false);
    setChallengeTimeLeft(null);
    setCountdown(null);
    setTransitionMsg('');
  }, []);

  // ── start — getUserMedia and model-ready wait run in parallel ───────────
  const start = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (video.srcObject) {
      (video.srcObject as MediaStream).getTracks().forEach(t => t.stop());
      video.pause();
      video.srcObject = null;
    }
    await new Promise<void>(r => setTimeout(r, 300));

    abortRef.current = false;
    go('starting');
    setErrMsg('');

    let stream: MediaStream;
    try {
      [stream] = await Promise.all([
        getCamera(),
        new Promise<void>(r => {
          if (modelReadyRef.current || modelErrRef.current) { r(); return; }
          const check = setInterval(() => {
            if (modelReadyRef.current || modelErrRef.current || abortRef.current) {
              clearInterval(check); r();
            }
          }, 100);
        }),
      ]);
    } catch (err) {
      if (abortRef.current) return;
      const e = err as Error & { name: string };
      const msg =
        e.name === 'NotAllowedError'  ? 'Camera permission denied — allow camera in browser settings.' :
        e.name === 'NotReadableError' ? 'Camera is in use by another app — close it and try again.' :
        e.name === 'TimeoutError'     ? 'Camera took too long — click Try Again to retry.' :
        (e.message?.includes('timeout') ? 'Camera took too long — click Try Again to retry.' :
        'Camera access denied — please allow camera access and retry.');
      setErrMsg(msg);
      go('error');
      return;
    }

    if (abortRef.current) { stream.getTracks().forEach(t => t.stop()); return; }

    if (modelErrRef.current) {
      stream.getTracks().forEach(t => t.stop());
      setErrMsg('Face detection model failed to load. Please refresh the page and try again.');
      go('error');
      return;
    }

    streamRef.current = stream;
    video.srcObject   = stream;

    await new Promise<void>(r => {
      if (video.readyState >= 2) { r(); return; }
      video.addEventListener('canplay', () => r(), { once: true });
    });

    if (abortRef.current) return;
    await video.play();

    const fm = fmRef.current;
    if (!fm || abortRef.current) return;

    sendingRef.current = false;
    activeRef.current  = true;
    sessionRef.current = Date.now();
    go('calibrating', 0);

    const tick = async () => {
      if (!activeRef.current) return;
      if (video.readyState >= 2 && !sendingRef.current) {
        sendingRef.current = true;
        try { await fm.send({ image: video }); } catch { /* skip frame */ }
        finally { sendingRef.current = false; }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [go]);

  // ── Modal open/close lifecycle ────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) { stop(); return; }
    resetRefs();
    setCalPct(0);
    setScore(0);
    setNoFace(false);
    setErrMsg('');
    phaseRef.current = 'idle';
    setPhase('idle');
    if (modelErrRef.current) {
      modelErrRef.current  = false;
      modelReadyRef.current = false;
      setModelErr(false);
      setModelReady(false);
      setModelLoadKey(prev => prev + 1);
    }
    start();
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // ── Capture trigger — fires once when phase reaches 'capturing' ───────────
  useEffect(() => {
    if (phase !== 'capturing') return;
    const video = videoRef.current;
    if (!video) return;

    activeRef.current  = false;
    sendingRef.current = false;
    if (challengeTimerRef.current !== null) {
      clearInterval(challengeTimerRef.current);
      challengeTimerRef.current = null;
    }
    if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }

    const snaps = snapsRef.current;
    let dataURL = '';
    for (let i = 0; i < snaps.length; i++) {
      if (snaps[i] && snaps[i].length > 2000) { dataURL = snaps[i]; break; }
    }

    if (!dataURL) {
      dataURL = captureFrame(video);
      if (dataURL) snapsRef.current.push(dataURL);
    }

    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;

    if (!dataURL || dataURL.length < 2000) {
      setErrMsg('Could not capture a valid selfie — please try again.');
      phaseRef.current = 'error';
      setPhase('error');
      return;
    }

    const blob = dataURLtoBlob(dataURL);
    go('done');

    const result: LivenessVerificationResult = {
      status:               'verified',
      confidence:           100,
      capturedImageBlob:    blob,
      capturedImageDataURL: dataURL,
      challenges: [
        { type: 'blink',      detected: true, confidence: 0.95, detectedAt: challengeTimestampsRef.current.blink      ?? Date.now() },
        { type: 'head_left',  detected: true, confidence: 0.95, detectedAt: challengeTimestampsRef.current.head_left  ?? Date.now() },
        { type: 'head_right', detected: true, confidence: 0.95, detectedAt: challengeTimestampsRef.current.head_right ?? Date.now() },
      ],
      verifiedAt:        new Date().toISOString(),
      sessionDurationMs: Date.now() - sessionRef.current,
    };
    onVerified(result);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // ── Escape key ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return;
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [isOpen, onClose]);

  if (!mounted || !isOpen) return null;

  // ── Derived UI ────────────────────────────────────────────────────────────
  const tasks = [
    { label: 'Face',       done: score >= 25  },
    { label: 'Blink',      done: score >= 50  },
    { label: 'Turn Left',  done: score >= 75  },
    { label: 'Turn Right', done: score >= 100 },
  ];

  const hint =
    phase === 'starting'    ? 'Starting camera…'                                      :
    phase === 'calibrating' ? `Hold still — calibrating (${calPct}%)`                :
    phase === 'face'        ? 'Face detected — get ready'                             :
    phase === 'blink'       ? '👁 Close BOTH eyes fully, then open them'              :
    phase === 'head_left'   ? '↩ Slowly turn your head to the LEFT and hold'          :
    phase === 'head_right'  ? '↪ Slowly turn your head to the RIGHT and hold'         :
    phase === 'capturing'   ? 'Capturing…'                                            :
    phase === 'done'        ? 'All challenges complete!'                              :
                              'Look at the camera';

  const isChallenge = phase === 'face' || phase === 'blink' || phase === 'head_left' || phase === 'head_right';

  const handleRetry = async () => {
    await fullReset();
    resetRefs();
    setScore(0);
    setCalPct(0);
    setNoFace(false);
    setErrMsg('');
    phaseRef.current = 'idle';
    setPhase('idle');
    if (modelErrRef.current) {
      modelErrRef.current  = false;
      modelReadyRef.current = false;
      setModelErr(false);
      setModelReady(false);
      setModelLoadKey(prev => prev + 1);
    }
    start();
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Liveness Verification"
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={onClose} />

      {/* Card */}
      <div
        className="relative bg-gray-900 rounded-3xl shadow-2xl w-full max-w-sm overflow-hidden"
        style={{ maxHeight: '90vh' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-sm font-semibold text-white">Identity Verification</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 rounded-full bg-white/10 flex items-center justify-center text-white/60 hover:text-white hover:bg-white/20 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* ── Error ── */}
        {phase === 'error' && (
          <div className="flex flex-col items-center gap-4 p-8 text-center">
            <div className="text-5xl">❌</div>
            <p className="text-white font-semibold">Verification Failed</p>
            <p className="text-white/55 text-xs max-w-xs leading-relaxed">
              {errMsg || 'Something went wrong — please try again.'}
            </p>
            <button
              type="button"
              onClick={handleRetry}
              className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-500 rounded-xl transition-colors"
            >
              <RefreshCw className="w-4 h-4" /> Try Again
            </button>
          </div>
        )}

        {/* ── Done ── */}
        {phase === 'done' && (
          <div className="flex flex-col items-center gap-4 p-10 text-center">
            <CheckCircle2 className="w-14 h-14 text-emerald-400" />
            <p className="text-white font-bold text-lg">Verified!</p>
            <p className="text-white/55 text-xs">Liveness check passed successfully</p>
          </div>
        )}

        {/* ── Camera + score panel ── */}
        {phase !== 'error' && phase !== 'done' && (
          <>
            {/* Camera viewport */}
            <div className="relative bg-black" style={{ aspectRatio: '3/4' }}>
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <video
                ref={videoRef}
                className="w-full h-full object-cover scale-x-[-1]"
                playsInline
                muted
                autoPlay
              />
              <canvas
                ref={canvasRef}
                className="absolute inset-0 w-full h-full scale-x-[-1] pointer-events-none"
              />

              {/* Phase hint pill */}
              {phase !== 'idle' && phase !== 'starting' && countdown === null && (
                <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-black/65 backdrop-blur-sm border border-white/15 text-white text-xs font-semibold px-3 py-1.5 rounded-full whitespace-nowrap max-w-[90%] text-center">
                  {hint}
                </div>
              )}

              {/* Challenge countdown timer — top-right corner */}
              {challengeTimeLeft !== null && countdown === null &&
               (phase === 'blink' || phase === 'head_left' || phase === 'head_right') && (
                <div className={`absolute top-3 right-3 text-xs font-mono px-2 py-1 rounded-full ${
                  challengeTimeLeft <= 5 ? 'bg-red-500/80 text-white' : 'bg-black/65 text-white/70'
                }`}>
                  {challengeTimeLeft}s
                </div>
              )}

              {/* Loading overlay */}
              {(phase === 'idle' || phase === 'starting') && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/75 px-6 text-center">
                  {modelErr ? (
                    <>
                      <p className="text-rose-400 text-sm font-semibold">Model failed to load</p>
                      <p className="text-white/50 text-xs leading-relaxed">
                        Could not download the face detection model. Check your connection and refresh the page.
                      </p>
                    </>
                  ) : (
                    <>
                      <Loader2 className="w-8 h-8 text-white/50 animate-spin" />
                      <p className="text-white/50 text-xs font-medium">
                        {!modelReady ? 'Loading face detection model…' : 'Starting camera…'}
                      </p>
                    </>
                  )}
                </div>
              )}

              {/* 7-second countdown circle between challenges */}
              {countdown !== null && (
                <div
                  className="absolute pointer-events-none"
                  style={{ bottom: '80px', left: '50%', transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', zIndex: 20 }}
                >
                  <div style={{
                    width: '56px', height: '56px', borderRadius: '50%',
                    background: 'rgba(0,0,0,0.65)', border: '2px solid #1D9E75',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '28px', fontWeight: '700', color: '#ffffff',
                  }}>
                    {countdown}
                  </div>
                  {transitionMsg && (
                    <span style={{
                      fontSize: '11px', color: 'rgba(255,255,255,0.85)',
                      background: 'rgba(0,0,0,0.55)', padding: '3px 10px',
                      borderRadius: '4px', whiteSpace: 'nowrap', maxWidth: '220px',
                      textAlign: 'center', lineHeight: '1.4',
                    }}>
                      {transitionMsg}
                    </span>
                  )}
                </div>
              )}

              {/* No-face warning during challenge phases */}
              {isChallenge && noFace && countdown === null && (
                <div className="absolute inset-x-0 bottom-4 flex justify-center">
                  <span className="bg-black/70 text-amber-300 text-xs font-medium px-3 py-1.5 rounded-full">
                    No face detected — look at the camera
                  </span>
                </div>
              )}

              {/* Retry button — shown on challenge timeout */}
              {showRetry && (phase === 'blink' || phase === 'head_left' || phase === 'head_right') && (
                <div className="absolute inset-x-0 bottom-14 flex justify-center">
                  <button
                    type="button"
                    onClick={handleRetry}
                    className="flex items-center gap-2 bg-blue-500/90 hover:bg-blue-400 text-white text-xs font-bold px-4 py-2 rounded-full transition-colors"
                  >
                    <RefreshCw className="w-3 h-3" /> Retry
                  </button>
                </div>
              )}
            </div>

            {/* Score + challenge instruction */}
            <div className="px-4 pt-3 pb-4 space-y-3">
              {/* Score bar */}
              <div>
                <div className="flex items-baseline justify-between mb-1.5">
                  <span className="text-[10px] font-medium uppercase tracking-wider text-white/40">
                    Score
                  </span>
                  <span className="text-2xl font-bold text-white tabular-nums leading-none">
                    {score}
                    <span className="text-xs font-medium text-white/40 ml-0.5">%</span>
                  </span>
                </div>

                <div className="h-2 rounded-full bg-white/10 overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{
                      width:      `${score}%`,
                      background: score >= 100
                        ? '#10b981'
                        : 'linear-gradient(to right, #f59e0b, #10b981)',
                    }}
                  />
                </div>

                <div className="flex justify-between mt-1.5 px-0.5">
                  {tasks.map(t => (
                    <span
                      key={t.label}
                      className={`text-[9px] font-medium transition-colors duration-300 ${
                        t.done ? 'text-emerald-400' : 'text-white/25'
                      }`}
                    >
                      {t.done ? '✓' : '○'} {t.label}
                    </span>
                  ))}
                </div>
              </div>

              {/* Challenge instruction card */}
              {isChallenge && (
                <div className="flex items-center gap-3 bg-white/5 border border-white/10 rounded-2xl px-4 py-3">
                  <span className="text-2xl leading-none flex-shrink-0">
                    {phase === 'face'       ? '🙂'  :
                     phase === 'blink'      ? '👁️'  :
                     phase === 'head_left'  ? '↩️'  : '↪️'}
                  </span>
                  <div className="min-w-0">
                    <p className="text-white font-bold text-sm leading-tight">
                      {phase === 'face'       ? 'Face Detected'         :
                       phase === 'blink'      ? 'Blink'                 :
                       phase === 'head_left'  ? 'Turn Head Left'        :
                                               'Turn Head Right'}
                    </p>
                    <p className="text-white/50 text-xs mt-0.5 leading-snug">
                      {phase === 'face'       ? 'Hold still — preparing next step'           :
                       phase === 'blink'      ? 'Tip: close your eyes slowly and fully'      :
                       phase === 'head_left'  ? 'Tip: turn slowly and hold for a moment'     :
                                               'Tip: turn slowly and hold for a moment'}
                    </p>
                  </div>
                  <div className="ml-auto flex-shrink-0 w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                </div>
              )}

              {/* Calibrating hint */}
              {phase === 'calibrating' && (
                <p className="text-center text-white/40 text-xs pb-1">
                  Hold still and look straight at the camera
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

