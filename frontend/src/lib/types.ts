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
