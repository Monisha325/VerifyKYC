export type Role      = 'APPLICANT' | 'REVIEWER' | 'ADMIN';
export type AppStatus = 'DRAFT' | 'SUBMITTED' | 'PROCESSING' | 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED';
export type DocKind   = 'AADHAAR' | 'PAN' | 'PASSPORT' | 'DRIVING_LICENCE' | 'SELFIE';
export type DocStatus = 'UPLOADED' | 'QUEUED' | 'PROCESSING' | 'VERIFIED' | 'NEEDS_REVIEW' | 'FAILED';
export type Decision  = 'APPROVED' | 'REJECTED' | 'ESCALATED';

export interface User {
  id:            string;
  email:         string;
  fullName:      string;
  role:          Role;
  isVerified:    boolean;
  emailVerified: boolean;
  createdAt:     string;
}

export interface AuthResponse {
  user:        User;
  accessToken: string;
}

export interface RegisterResponse {
  message: string;
  email:   string;
  devOtp?: string;
}

// ── Applicant-facing types ────────────────────────────────────────────────────

export interface DocumentVerification {
  id:            string;
  ocrConfidence: number | null;
  isAuthentic:   boolean | null;
  fraudScore:    number | null;
  rawAiResponse: {
    doc_confidence?: number;
    flags?:          string[];
    stages?:         Record<string, boolean>;
    signals?:        Record<string, unknown>;
  } | null;
  verifiedAt: string | null;
}

export interface KycDocument {
  id:                   string;
  kind:                 DocKind;
  status:               DocStatus;
  cloudinaryUrl:        string | null;
  uploadedAt:           string | null;
  updatedAt:            string;
  documentVerification: DocumentVerification | null;
}

export interface Application {
  id:                 string;
  userId:             string;
  status:             AppStatus;
  overallScore:       number | null;
  scoreBand:          string | null;
  submittedAt:        string | null;
  completedAt:        string | null;
  createdAt:          string;
  updatedAt:          string;
  livenessVerifiedAt: string | null;
  livenessConfidence: number | null;
  documents:          KycDocument[];
  reviewDecisions: Array<{
    decision:    Decision;
    reasonCodes: string[];
    decidedAt:   string;
  }>;
}

export interface ApiError {
  error:    string;
  details?: Record<string, string[]>;
}

// ── Reviewer-facing types ─────────────────────────────────────────────────────

export interface FiredFlag {
  code:  string;
  label: string;
}

export interface ReviewDocument {
  id:            string;
  kind:          DocKind;
  status:        DocStatus;
  signedUrl:     string | null;
  uploadedAt:    string | null;
  docConfidence: number | null;
  extractedFields: {
    fieldName:  string;
    fieldValue: string;
    confidence: number;
    source:     string;
  }[];
  authenticity: {
    isAuthentic:   boolean | null;
    ocrConfidence: number | null;
    score:         number | null;
    method:        string | null;
  };
  fraud: {
    score:      number | null;
    firedFlags: FiredFlag[];
  };
}

export interface IdentityCorrelationBundle {
  nameMatchScore:  number | null;
  dobMatchScore:   number | null;
  faceMatchScore:  number | null;
  overallScore:    number | null;
  isCorrelated:    boolean | null;
  subMatches: {
    name:    unknown;
    dob:     unknown;
    gender:  unknown;
    address: unknown;
    face:    unknown;
  };
  hardFails:   FiredFlag[];
  softFlags:   string[];
  faceDetails: { docId: string; similarity: number }[];
  faceReason:  string | null;
}

export interface PriorDecision {
  id:          string;
  decision:    Decision;
  reasonCodes: string[];
  notes:       string | null;
  decidedAt:   string;
}

export interface QueueItem {
  id:           string;
  status:       AppStatus;
  overallScore: number | null;
  scoreBand:    string | null;
  submittedAt:  string | null;
  createdAt:    string;
  claimedById:  string | null;
  claimedAt:    string | null;
  flagCount:    number;
  user:         { id: string; fullName: string; email: string };
}

export interface EvidenceBundle {
  id:                 string;
  status:             AppStatus;
  overallScore:       number | null;
  scoreBand:          string | null;
  autoRecommendation: string;
  claimedById:        string | null;
  claimedAt:          string | null;
  submittedAt:        string | null;
  applicant:          { id: string; fullName: string; email: string };
  documents:          ReviewDocument[];
  identityCorrelation: IdentityCorrelationBundle | null;
  priorDecisions:     PriorDecision[];
}

// ── Liveness verification types ─────────────────────────────────────────────
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
