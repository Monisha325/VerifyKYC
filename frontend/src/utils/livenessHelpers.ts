import type { LivenessStep } from '@/types/liveness';

export function selectChallenges(): Array<'blink' | 'smile' | 'mouth_open'> {
  return ['blink', 'smile', 'mouth_open'];
}

export function getInstructionForStep(step: LivenessStep): {
  title: string;
  subtitle: string;
  icon: string;
} {
  const map: Record<LivenessStep, { title: string; subtitle: string; icon: string }> = {
    idle:                  { icon: '📷', title: 'Getting Ready',       subtitle: 'Initialising camera...' },
    requesting_permission: { icon: '🔐', title: 'Camera Access',       subtitle: 'Please allow camera access to continue' },
    permission_denied:     { icon: '🚫', title: 'Access Denied',       subtitle: 'Camera permission is required for liveness check' },
    no_camera:             { icon: '📷', title: 'No Camera Found',     subtitle: 'Please connect a webcam to continue' },
    camera_starting:       { icon: '⏳', title: 'Starting Camera',     subtitle: 'Please wait...' },
    detecting_face:        { icon: '👤', title: 'Position Your Face',  subtitle: 'Look at the camera and fit your face in the oval' },
    face_too_far:          { icon: '🔍', title: 'Move Closer',         subtitle: 'Step closer to the camera' },
    face_too_close:        { icon: '↔️', title: 'Move Back',           subtitle: 'Step slightly away from the camera' },
    face_not_centered:     { icon: '🎯', title: 'Centre Your Face',    subtitle: 'Move your face to the middle of the oval' },
    lighting_too_dark:     { icon: '💡', title: 'Too Dark',            subtitle: 'Please find a brighter area or turn on a light' },
    lighting_too_bright:   { icon: '🌞', title: 'Too Bright',          subtitle: 'Move away from direct light or bright windows' },
    multiple_faces:        { icon: '👥', title: 'One Face Only',       subtitle: 'Please ensure only you are visible in the frame' },
    challenge_blink:       { icon: '👁️', title: 'Blink',               subtitle: 'Close and open both eyes once' },
    challenge_smile:       { icon: '😊', title: 'Smile',               subtitle: 'Give us a natural smile' },
    challenge_mouth_open:  { icon: '😮', title: 'Open Your Mouth',     subtitle: 'Open your mouth wide for a moment' },
    capturing:             { icon: '📸', title: 'Hold Still',           subtitle: 'Capturing your photo...' },
    preview:               { icon: '🖼️', title: 'Review Your Photo',   subtitle: 'Confirm the image looks good' },
    uploading:             { icon: '🔄', title: 'Verifying',            subtitle: 'Processing your liveness check...' },
    verified:              { icon: '✅', title: 'Verified!',            subtitle: 'Liveness check passed successfully' },
    failed:                { icon: '❌', title: 'Verification Failed',  subtitle: 'Please try again' },
    timeout:               { icon: '⏰', title: 'Session Timed Out',    subtitle: 'The session expired — please try again' },
  };
  return map[step];
}

export function calculateFinalConfidence(
  facePositionScore: number,
  challengesPassed: number,
  totalChallenges: number,
  lightingScore: number,
): number {
  const challengeScore = totalChallenges > 0 ? (challengesPassed / totalChallenges) * 40 : 0;
  const raw = Math.min(facePositionScore, 40) + challengeScore + Math.min(lightingScore, 20);
  return Math.max(0, Math.min(100, Math.round(raw)));
}

export function isSessionTimedOut(sessionStartTime: number): boolean {
  return Date.now() - sessionStartTime > 90_000;
}

export function getCameraPermissionInstructions(): { browser: string; steps: string[] } {
  const ua = navigator.userAgent;
  if (/Chrome\//.test(ua) && !/Edg\//.test(ua) && !/OPR\//.test(ua)) {
    return {
      browser: 'Chrome',
      steps: [
        'Click the camera icon in the address bar (top right)',
        'Select "Always allow [site] to access your camera"',
        'Click "Done" and refresh the page',
      ],
    };
  }
  if (/Edg\//.test(ua)) {
    return {
      browser: 'Edge',
      steps: [
        'Click the lock icon in the address bar',
        'Click "Permissions for this site"',
        'Set Camera to "Allow"',
        'Refresh the page',
      ],
    };
  }
  if (/Firefox\//.test(ua)) {
    return {
      browser: 'Firefox',
      steps: [
        'Click the camera icon in the address bar',
        'Select "Allow camera access"',
        'Click "Save changes" and refresh the page',
      ],
    };
  }
  if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) {
    return {
      browser: 'Safari',
      steps: [
        'Open Safari > Settings > Websites > Camera',
        'Find this website and set it to "Allow"',
        'Refresh the page',
      ],
    };
  }
  return {
    browser: 'your browser',
    steps: [
      'Look for a camera icon or lock icon in your browser address bar',
      'Allow camera access for this website',
      'Refresh the page and try again',
    ],
  };
}
