export type LivenessStep =
  | 'idle'
  | 'requesting_permission'
  | 'permission_denied'
  | 'no_camera'
  | 'camera_starting'
  | 'detecting_face'
  | 'face_too_far'
  | 'face_too_close'
  | 'face_not_centered'
  | 'lighting_too_dark'
  | 'lighting_too_bright'
  | 'multiple_faces'
  | 'challenge_blink'
  | 'challenge_smile'
  | 'challenge_mouth_open'
  | 'capturing'
  | 'preview'
  | 'uploading'
  | 'verified'
  | 'failed'
  | 'timeout';

export interface FacePosition {
  x: number;
  y: number;
  width: number;
  height: number;
  isCentered: boolean;
  isCorrectSize: boolean;
}

export interface LightingResult {
  averageBrightness: number;
  isDark: boolean;
  isBright: boolean;
  isAcceptable: boolean;
}

export interface ChallengeResult {
  type: 'blink' | 'smile' | 'mouth_open' | 'head_left' | 'head_right';
  detected: boolean;
  confidence: number;
  detectedAt: number;
}

export interface LivenessVerificationResult {
  status: 'verified' | 'failed';
  confidence: number;
  capturedImageBlob: Blob | null;
  capturedImageDataURL: string | null;
  challenges: ChallengeResult[];
  failureReason?: string;
  verifiedAt: string;
  sessionDurationMs: number;
}

export interface LivenessState {
  step: LivenessStep;
  confidence: number;
  facePosition: FacePosition | null;
  lighting: LightingResult | null;
  challenges: ChallengeResult[];
  pendingChallenges: Array<'blink' | 'smile' | 'mouth_open'>;
  capturedBlob: Blob | null;
  capturedDataURL: string | null;
  errorMessage: string | null;
  sessionStartTime: number | null;
  attemptCount: number;
  isSimulationMode: boolean;
}

export type LivenessAction =
  | { type: 'START_CAMERA' }
  | { type: 'CAMERA_READY'; payload: Array<'blink' | 'smile' | 'mouth_open'> }
  | { type: 'PERMISSION_DENIED' }
  | { type: 'NO_CAMERA' }
  | { type: 'FACE_DETECTED'; payload: FacePosition }
  | { type: 'FACE_LOST' }
  | { type: 'FACE_TOO_FAR' }
  | { type: 'FACE_TOO_CLOSE' }
  | { type: 'FACE_NOT_CENTERED' }
  | { type: 'MULTIPLE_FACES' }
  | { type: 'LIGHTING_BAD'; payload: LightingResult }
  | { type: 'LIGHTING_OK' }
  | { type: 'UPDATE_CONFIDENCE'; payload: number }
  | { type: 'BEGIN_CHALLENGE'; payload: 'blink' | 'smile' | 'mouth_open' }
  | { type: 'CHALLENGE_PASSED'; payload: ChallengeResult }
  | { type: 'CHALLENGE_FAILED'; payload: string }
  | { type: 'CAPTURE' }
  | { type: 'CAPTURE_DONE'; payload: { blob: Blob; dataURL: string } }
  | { type: 'UPLOAD_START' }
  | { type: 'VERIFIED'; payload: number }
  | { type: 'FAILED'; payload: string }
  | { type: 'TIMEOUT' }
  | { type: 'RETRY' }
  | { type: 'SET_SIMULATION_MODE' };
