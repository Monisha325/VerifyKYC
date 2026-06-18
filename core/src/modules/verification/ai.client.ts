/**
 * Typed HTTP client for the AI service.
 * Uses Node 18+ built-in fetch (we run on Node 22).
 * All requests carry X-Internal-Token for service-to-service auth.
 */

const AI_URL   = process.env.AI_SERVICE_URL || 'http://localhost:8000';
const AI_TOKEN = process.env.INTERNAL_TOKEN || '';

async function aiPost<T>(path: string, body: unknown, timeoutMs = 30_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const resp = await fetch(`${AI_URL}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Token': AI_TOKEN },
    body:    JSON.stringify(body),
    signal:  controller.signal,
  }).finally(() => clearTimeout(timer));
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`AI ${path} → ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json() as Promise<T>;
}

// ── Response shapes ───────────────────────────────────────────────────────────

export interface QualityResult {
  blur_score:      number;
  blur_pass:       boolean;
  glare_ratio:     number;
  glare_pass:      boolean;
  exposure:        string;
  resolution:      { width: number; height: number; megapixels: number };
  resolution_pass: boolean;
  overall_pass:    boolean;
  quality_score?:  number;
}

// Enhanced Aadhaar-specific quality result from POST /ai/quality/aadhaar.
// Extends QualityResult so pipeline.ts can consume it without changes.
export interface AadhaarQualityResult extends QualityResult {
  quality_tier:             string;
  document_type:            string;
  card_variant:             'full' | 'masked' | 'unknown';
  card_detected:            boolean;
  dual_side_detected:       boolean;
  watermark_detected:       boolean;
  photocopy_detected:       boolean;
  scanned_copy_detected:    boolean;
  ui_chrome_removed:        boolean;
  perspective_corrected:    boolean;
  orientation_corrected:    boolean;
  zone_thresholds_adjusted: boolean;
  manual_review_required:   boolean;
  isolated_card_dimensions: { width: number; height: number };
  zone_boundaries_used:     { top_zone_percent: number; middle_zone_percent: number; bottom_zone_percent: number };
  checks:                   Record<string, unknown>;
  warnings:                 { code: string; details: string; penalty: number }[];
  fail_reasons:             { check: string; zone: string | null; measured: unknown; threshold: string }[];
  gradients:                { blur_gradient: number; zone_blur_gradient: number; glare_gradient: number; exposure_gradient: number };
  penalties_applied:        { reason: string; penalty: number }[];
  total_penalty:            number;
  base_score:               number;
}

export interface OcrSegment {
  text: string;
  box:  { x: number; y: number; w: number; h: number };
  conf: number;
}

export interface OcrResult {
  segments:       OcrSegment[];
  full_text:      string;
  avg_confidence: number;
  language_hint:  string[];
}

export interface ClassifyResult {
  doc_type:        string;   // "AADHAAR"|"PAN"|"PASSPORT"|"DRIVING_LICENCE"|"UNKNOWN"
  confidence:      number;   // 0..1
  matched_anchors: string[];
}

export interface TamperingRegion {
  x: number; y: number; w: number; h: number;
  source: string;
}

export interface TamperingResult {
  ela_score:        number;   // 0..1
  copy_move_score:  number;   // 0..1
  verdict:          string;   // "clean"|"suspicious"|"tampered"
  regions:          TamperingRegion[];
}

// ── Calls ─────────────────────────────────────────────────────────────────────

export async function checkQuality(imageUrl: string, docKind?: string): Promise<QualityResult> {
  if (docKind === 'AADHAAR') {
    const r = await aiPost<AadhaarQualityResult>('/ai/quality/aadhaar', { image_url: imageUrl });
    // Adapt to the standard QualityResult shape so pipeline.ts needs no changes.
    const checks = r.checks as Record<string, Record<string, unknown>>;
    const blur   = checks['blur']        as Record<string, unknown> | undefined;
    const glare  = checks['glare']       as Record<string, unknown> | undefined;
    const oe     = checks['overexposure'] as Record<string, unknown> | undefined;
    const ue     = checks['underexposure'] as Record<string, unknown> | undefined;
    const res    = checks['resolution']  as Record<string, unknown> | undefined;
    const exposure =
      oe?.['pass'] === false ? 'overexposed' :
      ue?.['pass'] === false ? 'underexposed' : 'normal';
    return {
      ...r,
      blur_score:      (blur?.['global_value']  as number) ?? 0,
      blur_pass:       (blur?.['pass']          as boolean) ?? r.overall_pass,
      glare_ratio:     ((glare?.['full_card_percent'] as number) ?? 0) / 100,
      glare_pass:      (glare?.['pass']         as boolean) ?? true,
      exposure,
      resolution: {
        width:      (res?.['width']      as number) ?? r.isolated_card_dimensions.width,
        height:     (res?.['height']     as number) ?? r.isolated_card_dimensions.height,
        megapixels: Math.round(
          (r.isolated_card_dimensions.width * r.isolated_card_dimensions.height) / 1_000_000 * 100,
        ) / 100,
      },
      resolution_pass: (res?.['pass'] as boolean) ?? r.overall_pass,
      quality_score:   r.quality_score,
    };
  }
  return aiPost<QualityResult>('/ai/quality', { image_url: imageUrl, doc_type: docKind });
}

export function runOcr(imageUrl: string, languages = ['en']): Promise<OcrResult> {
  return aiPost<OcrResult>('/ai/ocr', { image_url: imageUrl, languages }, 300_000); // 5 min — EasyOCR cold-start on first call
}

export function classifyDocument(ocrText: string): Promise<ClassifyResult> {
  return aiPost<ClassifyResult>('/ai/classify', { ocr_text: ocrText });
}

export function checkTampering(imageUrl: string): Promise<TamperingResult> {
  return aiPost<TamperingResult>('/ai/tampering', { image_url: imageUrl });
}

// ── Aadhaar QR cryptographic verification ─────────────────────────────────────

export interface AadhaarQrResult {
  qr_found:        boolean;
  qr_type:         string;          // 'secure' | 'old' | 'none'
  crypto_verified: boolean;
  signature_valid: boolean | null;  // null → not attempted; true/false → RSA result
  // Masked demographics (only when crypto_verified=true)
  reference_id:    string | null;   // last-4 digits + UNIX timestamp, never full number
  name:            string | null;
  dob:             string | null;
  gender:          string | null;
  care_of:         string | null;
  district:        string | null;
  pincode:         string | null;
  post_office:     string | null;
  state:           string | null;
  // Privacy markers only — never actual values
  mobile_linked:   boolean;
  email_linked:    boolean;
  photo_present:   boolean;
  fail_reason:     string | null;
}

export function verifyAadhaarQr(imageUrl: string): Promise<AadhaarQrResult> {
  return aiPost<AadhaarQrResult>('/ai/qr/aadhaar', { image_url: imageUrl }, 60_000);
}

// ── QR code + EXIF metadata check ─────────────────────────────────────────────

export interface QrExifResult {
  qr_found:      boolean;
  qr_count:      number;
  qr_data:       string[];
  exif_flags:    string[];    // e.g. "editing_software_detected", "datetime_modified_after_capture"
  exif_software: string | null;
  exif_summary:  string;      // "clean" | "suspicious" | "no_exif"
}

export function checkQrExif(imageUrl: string): Promise<QrExifResult> {
  return aiPost<QrExifResult>('/ai/qr-exif', { image_url: imageUrl });
}

// ── PAN card QR verification ──────────────────────────────────────────────────

export interface PanQrResult {
  qr_found:          boolean;
  verification_path: string;          // 'AUTHORITATIVE_ONE' | 'UNVERIFIED' | 'FALLBACK'
  card_authentic:    boolean;
  // Masked PII — safe to log/store
  pan_masked:        string | null;   // "AB****4F"
  name:              string | null;
  father_name:       string | null;
  dob:               string | null;
  gender:            string | null;
  entity_type:       string | null;   // 'individual' | 'company' | 'huf' | …
  // Photo (for Stage B face match only — not persisted)
  photo_present:     boolean;
  photo_b64:         string | null;   // base64 JPEG from QR payload
  // Verification
  signature_valid:   boolean | null;  // null = not attempted (cert unavailable)
  // Fraud signals
  fraud_flags:       string[];
  fail_reason:       string | null;
}

export function verifyPanQr(imageUrl: string): Promise<PanQrResult> {
  return aiPost<PanQrResult>('/ai/qr/pan', { image_url: imageUrl }, 60_000);
}

// ── Face verification ─────────────────────────────────────────────────────────

export interface FaceVerifyResult {
  face_match: number;   // 0..1 — normalised score returned by the AI service
  match:      boolean;
  distance:   number;
  threshold:  number;
  flag:       string | null;
}

export function verifyFace(selfieUrl: string, docUrl: string): Promise<FaceVerifyResult> {
  return aiPost<FaceVerifyResult>('/ai/face/verify', {
    selfie_url:    selfieUrl,
    doc_photo_url: docUrl,
  }, 600_000); // 10 min — matches STAGE_TIMEOUTS.face_verify
}

export function verifyFaceVsB64(cardUrl: string, photoB64: string): Promise<FaceVerifyResult> {
  return aiPost<FaceVerifyResult>('/ai/face/verify-b64', {
    card_url:  cardUrl,
    photo_b64: photoB64,
  }, 180_000);
}

// ── Profile face verification (ArcFace cosine similarity, multi-document) ─────

export interface DocFaceScore {
  doc_url:    string;
  cosine_sim: number;
  score:      number;    // 0 | 40 | 75 | 100
}

export interface FaceVerifyProfileResult {
  scores:                   DocFaceScore[];
  average_score:            number;
  profile_verification_pct: number;   // 0–100 averaged discrete score
  flag:                     string | null;
  reason:                   string | null | undefined;
}

export function verifyFaceProfile(
  selfieUrl: string,
  docUrls:   string[],
): Promise<FaceVerifyProfileResult> {
  return aiPost<FaceVerifyProfileResult>('/ai/face/verify-profile', {
    selfie_url: selfieUrl,
    doc_urls:   docUrls,
  }, 600_000);  // 10 min — ArcFace cold-start on first call
}

// ── Selfie active-liveness analysis ──────────────────────────────────────────

export interface LivenessAnalysisResult {
  status:              'verified' | 'failed';
  confidence:          number;
  faces_per_snapshot:  number[];
  message:             string;
  processing_time_ms:  number;
}

export function analyzeLiveness(snapshots: string[], challenges: string[]): Promise<LivenessAnalysisResult> {
  return aiPost<LivenessAnalysisResult>('/ai/liveness/analyze', { snapshots, challenges }, 60_000);
}

// ── Face detection (selfie quality gate) ──────────────────────────────────────

export interface FaceDetectResult {
  count:  number;
  faces:  { box: { x: number; y: number; w: number; h: number }; conf: number }[];
  error:  string | null;   // "NO_FACE_DETECTED" | "MULTIPLE_FACES" | null
}

export function detectFace(imageUrl: string): Promise<FaceDetectResult> {
  return aiPost<FaceDetectResult>('/ai/face/detect', { image_url: imageUrl }, 60_000);
}
