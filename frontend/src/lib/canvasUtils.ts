import type { FacePosition, LightingResult } from '@/lib/types';

export async function captureFrameFromVideo(
  videoEl: HTMLVideoElement,
  quality = 0.85,
): Promise<{ blob: Blob; dataURL: string }> {
  const canvas = document.createElement('canvas');
  canvas.width  = videoEl.videoWidth  || 640;
  canvas.height = videoEl.videoHeight || 480;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');

  for (let attempt = 0; attempt < 3; attempt++) {
    ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, 10, 10);
    if (imageData.data.some(v => v > 0)) break;
    if (attempt < 2) await new Promise(r => setTimeout(r, 100));
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => {
        if (!blob) { reject(new Error('Failed to capture frame')); return; }
        resolve({ blob, dataURL: canvas.toDataURL('image/jpeg', quality) });
      },
      'image/jpeg',
      quality,
    );
  });
}

export function measureBrightness(
  videoEl: HTMLVideoElement,
  canvas: HTMLCanvasElement,
): LightingResult {
  const ctx = canvas.getContext('2d');
  if (!ctx || videoEl.videoWidth === 0) {
    return { averageBrightness: 128, isDark: false, isBright: false, isAcceptable: true };
  }

  ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);

  const scaleX = canvas.width  / videoEl.videoWidth;
  const scaleY = canvas.height / videoEl.videoHeight;
  const sampleW = Math.floor(100 * scaleX);
  const sampleH = Math.floor(100 * scaleY);
  const sampleX = Math.floor((canvas.width  - sampleW) / 2);
  const sampleY = Math.floor((canvas.height - sampleH) / 2);

  const imageData = ctx.getImageData(sampleX, sampleY, sampleW, sampleH);
  const pixels = imageData.data;
  let total = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    total += 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
  }
  const averageBrightness = total / (pixels.length / 4);

  return {
    averageBrightness,
    isDark:        averageBrightness < 50,
    isBright:      averageBrightness > 220,
    isAcceptable:  averageBrightness >= 50 && averageBrightness <= 220,
  };
}

export function analyzeFacePosition(
  detection: { box: { x: number; y: number; width: number; height: number } },
  canvasWidth: number,
  canvasHeight: number,
): FacePosition {
  const { x, y, width, height } = detection.box;
  const faceWidthRatio  = width  / canvasWidth;
  const faceHeightRatio = height / canvasHeight;
  // x/y are the normalised centre of the detected face bounding box.
  const faceCenterX = (x + width  / 2) / canvasWidth;
  const faceCenterY = (y + height / 2) / canvasHeight;

  const isCentered =
    Math.abs(faceCenterX - 0.5) < 0.25 &&
    Math.abs(faceCenterY - 0.5) < 0.25;

  const isCorrectSize = faceWidthRatio >= 0.15 && faceWidthRatio <= 0.85;

  return { x: faceCenterX, y: faceCenterY, width: faceWidthRatio, height: faceHeightRatio, isCentered, isCorrectSize };
}

export function calculateMAR(
  landmarks: { positions: Array<{ x: number; y: number }> },
): number {
  const p = landmarks.positions;
  function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
  }
  // Inner lip vertical / inner lip horizontal
  const vertical   = dist(p[62], p[66]);
  const horizontal = dist(p[60], p[64]);
  return horizontal > 0 ? vertical / horizontal : 0;
}

export function calculateEAR(
  landmarks: { positions: Array<{ x: number; y: number }> },
): number {
  const p = landmarks.positions;
  function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
  }
  const leftEAR  = (dist(p[37], p[41]) + dist(p[38], p[40])) / (2 * dist(p[36], p[39]));
  const rightEAR = (dist(p[43], p[47]) + dist(p[44], p[46])) / (2 * dist(p[42], p[45]));
  return (leftEAR + rightEAR) / 2;
}

export function detectNodFromHistory(
  noseTipHistory: Array<{ y: number; timestamp: number }>,
): boolean {
  if (noseTipHistory.length < 10) return false;

  let peakY = -Infinity;
  let peakIdx = 0;
  for (let i = 0; i < noseTipHistory.length; i++) {
    if (noseTipHistory[i].y > peakY) { peakY = noseTipHistory[i].y; peakIdx = i; }
  }

  if (peakIdx < 3 || peakIdx > noseTipHistory.length - 3) return false;

  const startY  = noseTipHistory.slice(0, 3).reduce((s, f) => s + f.y, 0) / 3;
  const endY    = noseTipHistory.slice(-3).reduce((s, f) => s + f.y, 0) / 3;

  return (peakY - startY) > 8 && (peakY - endY) > 8;
}

export function drawLandmarksOnCanvas(
  canvas: HTMLCanvasElement,
  landmarks: Array<{ x: number; y: number }>,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = 'rgba(0,255,128,0.7)';
  for (const pt of landmarks) {
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 2, 0, Math.PI * 2);
    ctx.fill();
  }
}
