/**
 * Extract named, structured fields from raw OCR text per document kind.
 *
 * OCR text from real documents is noisy — patterns are intentionally loose.
 * Returns a flat key→value map; absent fields are simply not in the map.
 * The pipeline persists found fields as ExtractedField rows (source: 'structured').
 */

import { DocKind } from '@prisma/client';
import { parseMrzLine2 } from './document.validators';

export interface DocFields {
  identifier?:  string;    // primary ID number for this document type
  name?:        string;
  father_name?: string;
  dob?:         string;    // ISO-ish: DD/MM/YYYY or YYYYMMDD from MRZ
  gender?:      string;
  nationality?: string;
  expiry?:      string;
  address?:     string;
  mrz_line2?:   string;
  [key: string]: string | undefined;
}

export interface FieldValidation {
  field:   string;         // named field key
  value:   string;
  present: boolean;
  valid:   boolean;
  reason?: string;         // populated on invalid
}

export interface ExtractionResult {
  fields:           DocFields;
  validations:      FieldValidation[];
  field_completeness: number;   // 0..100
}

// ── Required fields per kind ──────────────────────────────────────────────────

const REQUIRED: Record<DocKind, (keyof DocFields)[]> = {
  AADHAAR:         ['identifier', 'name', 'dob'],
  PAN:             ['identifier', 'name'],
  PASSPORT:        ['identifier', 'name', 'dob', 'expiry', 'nationality'],
  DRIVING_LICENCE: ['identifier', 'name', 'dob', 'expiry'],
  SELFIE:          [],
};

// ── Extraction ────────────────────────────────────────────────────────────────

export function extractFields(kind: DocKind, ocrText: string): ExtractionResult {
  const t = ocrText;
  let fields: DocFields;

  switch (kind) {
    case DocKind.AADHAAR:         fields = _aadhaar(t); break;
    case DocKind.PAN:             fields = _pan(t);     break;
    case DocKind.PASSPORT:        fields = _passport(t); break;
    case DocKind.DRIVING_LICENCE: fields = _dl(t);      break;
    default:                      fields = {};
  }

  const required = REQUIRED[kind] ?? [];
  const validations = required.map(f => _validate(f as string, fields[f]));

  const present = validations.filter(v => v.present).length;
  const valid   = validations.filter(v => v.valid).length;
  const total   = required.length;

  const field_completeness = total === 0
    ? 100
    : Math.round((present / total) * 70 + (valid / total) * 30);

  return { fields, validations, field_completeness };
}

// ── Per-kind extractors ───────────────────────────────────────────────────────

function _aadhaar(t: string): DocFields {
  const fields: DocFields = {};

  // 12-digit Aadhaar number (may have spaces every 4 digits).
  // Compliance: store only the masked last-4; never write the full number.
  const idMatch = t.match(/\b(\d{4}[\s-]?\d{4}[\s-]?\d{4})\b/);
  if (idMatch) {
    const digits = idMatch[1].replace(/\D/g, '');
    fields.identifier = `XXXX XXXX ${digits.slice(8, 12)}`;
  }

  fields.name   = _extractName(t);
  fields.dob    = _extractDob(t);
  fields.gender = _extractGender(t);

  // Address: everything after "Address" label, up to 200 chars
  const addrMatch = t.match(/address[:\s]+(.{10,200}?)(?:\n|$)/i);
  if (addrMatch) fields.address = addrMatch[1].trim();

  return fields;
}

function _pan(t: string): DocFields {
  const fields: DocFields = {};

  // PAN: 5 uppercase letters, 4 digits, 1 uppercase letter
  const idMatch = t.match(/\b([A-Z]{5}\d{4}[A-Z])\b/);
  if (idMatch) fields.identifier = idMatch[1];

  fields.name        = _extractName(t);
  fields.father_name = _extractFatherName(t);
  fields.dob         = _extractDob(t);

  return fields;
}

function _passport(t: string): DocFields {
  const fields: DocFields = {};

  // Try MRZ-based extraction first (most reliable)
  const mrz = parseMrzLine2(t);
  if (mrz) {
    fields.mrz_line2    = mrz;
    fields.identifier   = mrz.slice(0, 9).replace(/</g, '').trim();
    fields.nationality  = mrz.slice(10, 13).replace(/</g, '').trim();
    fields.dob          = mrz.slice(13, 19);
    fields.gender       = mrz[20] === 'M' ? 'M' : mrz[20] === 'F' ? 'F' : '<';
    fields.expiry       = mrz.slice(21, 27);
  }

  // Fallback: free-text patterns
  if (!fields.identifier) {
    const ppMatch = t.match(/(?:passport\s*(?:no|number)[.:\s]+)([A-Z]\d{7})/i);
    if (ppMatch) fields.identifier = ppMatch[1].toUpperCase();
  }

  if (!fields.name) fields.name = _extractName(t);

  return fields;
}

function _dl(t: string): DocFields {
  const fields: DocFields = {};

  // Indian DL: SS-RR-YYYY-NNNNNNN
  const idMatch = t.match(/\b([A-Z]{2}[\s-]?\d{2}[\s-]\d{4}[\s-]\d{7})\b/i);
  if (idMatch) fields.identifier = idMatch[1].replace(/\s/g, '').toUpperCase();

  fields.name   = _extractName(t);
  fields.dob    = _extractDob(t);
  fields.expiry = _extractExpiry(t);

  return fields;
}

// ── Shared extractors ─────────────────────────────────────────────────────────

function _extractName(t: string): string | undefined {
  // Lines with "name:" label
  const labeled = t.match(/(?:(?:^|\n)\s*name[:\s]+)([A-Z][a-zA-Z ]{2,40})/im);
  if (labeled) return labeled[1].trim();

  // All-caps name (common in Indian IDs): 2–5 words of uppercase letters
  const caps = t.match(/\b([A-Z]{2,20}(?:\s+[A-Z]{2,20}){1,4})\b/);
  if (caps) return caps[1].trim();

  return undefined;
}

function _extractFatherName(t: string): string | undefined {
  const m = t.match(/(?:father'?s?\s*name|f\/o)[:\s]+([A-Za-z ]{2,40})/i);
  return m ? m[1].trim() : undefined;
}

function _extractDob(t: string): string | undefined {
  // DD/MM/YYYY or DD-MM-YYYY
  const m1 = t.match(/\b(\d{2}[\/\-]\d{2}[\/\-]\d{4})\b/);
  if (m1) return m1[1];
  // Year of birth
  const m2 = t.match(/(?:year\s*of\s*birth|yob)[:\s]+(\d{4})/i);
  if (m2) return m2[1];
  return undefined;
}

function _extractExpiry(t: string): string | undefined {
  const m = t.match(/(?:valid(?:ity)?(?:\s*till)?|expir(?:y|es?)|valid\s*upto)[:\s]+(\d{2}[\/\-]\d{2}[\/\-]\d{4})/i);
  return m ? m[1] : undefined;
}

function _extractGender(t: string): string | undefined {
  if (/\b(?:male|m)\b/i.test(t)) return 'M';
  if (/\b(?:female|f)\b/i.test(t)) return 'F';
  return undefined;
}

// ── Field validation ──────────────────────────────────────────────────────────

function _validate(field: string, value: string | undefined): FieldValidation {
  if (!value || value.trim() === '') {
    return { field, value: '', present: false, valid: false, reason: 'missing' };
  }

  const v = value.trim();

  switch (field) {
    case 'identifier': {
      // Just check non-empty here; type-specific checks are in the registry provider
      const ok = v.length >= 6;
      return { field, value: v, present: true, valid: ok, reason: ok ? undefined : 'too_short' };
    }
    case 'name': {
      const ok = /^[A-Za-z\s.'-]{2,80}$/.test(v);
      return { field, value: v, present: true, valid: ok, reason: ok ? undefined : 'non_alphabetic' };
    }
    case 'dob': {
      const parsed = _parseDate(v);
      if (!parsed) return { field, value: v, present: true, valid: false, reason: 'unparseable_date' };
      const now = new Date();
      if (parsed > now) return { field, value: v, present: true, valid: false, reason: 'future_dob' };
      // DOB can't be more than 130 years ago
      const minDate = new Date(now.getFullYear() - 130, 0, 1);
      if (parsed < minDate) return { field, value: v, present: true, valid: false, reason: 'implausible_dob' };
      return { field, value: v, present: true, valid: true };
    }
    case 'expiry': {
      const parsed = _parseDate(v);
      if (!parsed) return { field, value: v, present: true, valid: false, reason: 'unparseable_date' };
      // Don't hard-fail on expired documents — just record it; fraud stage handles the weight
      return { field, value: v, present: true, valid: true };
    }
    default:
      return { field, value: v, present: true, valid: v.length > 0 };
  }
}

function _parseDate(s: string): Date | null {
  // DD/MM/YYYY or DD-MM-YYYY
  const m1 = s.match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})$/);
  if (m1) return new Date(+m1[3], +m1[2] - 1, +m1[1]);
  // YYMMDD (MRZ format) — two-digit year 00-24 → 2000-2024, 25-99 → 1925-1999
  const m2 = s.match(/^(\d{2})(\d{2})(\d{2})$/);
  if (m2) {
    const yy = +m2[1];
    const yyyy = yy <= 24 ? 2000 + yy : 1900 + yy;
    return new Date(yyyy, +m2[2] - 1, +m2[3]);
  }
  // Bare 4-digit year (year of birth)
  const m3 = s.match(/^(\d{4})$/);
  if (m3) return new Date(+m3[1], 0, 1);
  return null;
}
