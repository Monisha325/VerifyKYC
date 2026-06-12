/**
 * Pure document-validation functions.
 * No I/O, no side-effects — safe to unit-test directly.
 *
 *  verhoeffValid  — AADHAAR 12-digit Verhoeff checksum (residue must be 0)
 *  panValid       — PAN card regex per Income Tax Dept format
 *  mrzCheckDigit  — ICAO 9303 7-3-1 weighted check digit
 *  validateMrz    — full TD3 passport MRZ second-line validation
 *  parseMrzLine2  — locate a valid MRZ second line inside raw OCR text
 */

// ── Verhoeff ──────────────────────────────────────────────────────────────────

/** D[i][j] — the Dihedral D5 multiplication table */
const _VD = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
] as const;

/** P[i][j] — permutation table */
const _VP = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
] as const;

/**
 * Returns true when the 12-digit Aadhaar number passes the Verhoeff checksum
 * (final accumulator must be 0).  Strips whitespace before checking.
 */
export function verhoeffValid(number: string): boolean {
  const digits = number.replace(/\s+/g, '').split('').reverse().map(Number);
  if (digits.length !== 12 || digits.some(isNaN)) return false;
  let c = 0;
  for (let i = 0; i < digits.length; i++) {
    c = _VD[c][_VP[i % 8][digits[i]]];
  }
  return c === 0;
}

// ── PAN ───────────────────────────────────────────────────────────────────────

/**
 * 4th character encodes entity type — allowed set per Income Tax Dept:
 * A B C F G H L J P T K
 */
const _PAN_RE = /^[A-Z]{3}[ABCFGHLJPTK][A-Z]\d{4}[A-Z]$/;

export function panValid(pan: string): boolean {
  return _PAN_RE.test(pan.trim().toUpperCase());
}

// ── MRZ / ICAO 9303 ───────────────────────────────────────────────────────────

/**
 * Compute a single ICAO 9303 check digit over the given string.
 * Weights cycle 7-3-1.  '<' = 0, digits as-is, A=10 … Z=35.
 */
export function mrzCheckDigit(str: string): number {
  const WEIGHTS = [7, 3, 1] as const;
  let sum = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    let val: number;
    if (ch === '<')                         val = 0;
    else if (ch >= '0' && ch <= '9')        val = ch.charCodeAt(0) - 48;
    else if (ch >= 'A' && ch <= 'Z')        val = ch.charCodeAt(0) - 55; // A=10
    else                                     val = 0;
    sum += val * WEIGHTS[i % 3];
  }
  return sum % 10;
}

export interface MrzValidationResult {
  valid:          boolean;
  checksValid:    boolean[];        // [docNo, dob, expiry, personal, composite]
  docNumber:      string;
  nationality:    string;
  dob:            string;           // YYMMDD
  sex:            string;
  expiry:         string;           // YYMMDD
  personalNumber: string;
  failedChecks:   string[];
}

/**
 * Validate the 44-character second line of a TD3 (standard passport) MRZ.
 * Returns structured results; valid === true only when ALL five check digits pass.
 */
export function validateMrz(line2: string): MrzValidationResult {
  const L = line2.toUpperCase();
  const failedChecks: string[] = [];

  if (L.length !== 44) {
    return {
      valid: false, checksValid: [false, false, false, false, false],
      docNumber: '', nationality: '', dob: '', sex: '', expiry: '',
      personalNumber: '', failedChecks: ['wrong_length'],
    };
  }

  // Field positions (0-indexed)
  const docNumber    = L.slice(0, 9);
  const checkDocNo   = parseInt(L[9], 10);
  const nationality  = L.slice(10, 13);
  const dob          = L.slice(13, 19);
  const checkDob     = parseInt(L[19], 10);
  const sex          = L[20];
  const expiry       = L.slice(21, 27);
  const checkExpiry  = parseInt(L[27], 10);
  const personalNo   = L.slice(28, 42);
  const checkPersonal = parseInt(L[42], 10);
  // Composite = docNumber+checkDocNo + dob+checkDob + expiry+checkExpiry + personalNo+checkPersonal
  const compositeStr = L.slice(0, 10) + L.slice(13, 20) + L.slice(21, 28) + L.slice(28, 43);
  const checkComposite = parseInt(L[43], 10);

  const c1 = mrzCheckDigit(docNumber)   === checkDocNo;
  const c2 = mrzCheckDigit(dob)         === checkDob;
  const c3 = mrzCheckDigit(expiry)      === checkExpiry;
  const c4 = mrzCheckDigit(personalNo)  === checkPersonal;
  const c5 = mrzCheckDigit(compositeStr) === checkComposite;

  if (!c1) failedChecks.push('doc_number_check');
  if (!c2) failedChecks.push('dob_check');
  if (!c3) failedChecks.push('expiry_check');
  if (!c4) failedChecks.push('personal_number_check');
  if (!c5) failedChecks.push('composite_check');

  return {
    valid: c1 && c2 && c3 && c4 && c5,
    checksValid: [c1, c2, c3, c4, c5],
    docNumber,
    nationality,
    dob,
    sex,
    expiry,
    personalNumber: personalNo,
    failedChecks,
  };
}

/**
 * Scan raw OCR text for a 44-character TD3 MRZ second line.
 * Returns the first candidate that looks like a valid MRZ line
 * (all-uppercase, digits, and '<' only) or null.
 */
export function parseMrzLine2(ocrText: string): string | null {
  const MRZ_LINE2 = /^[A-Z0-9<]{44}$/;
  const candidates = ocrText
    .toUpperCase()
    .split(/\s*\n\s*|\s{3,}/)
    .map(l => l.replace(/\s/g, ''))
    .filter(l => MRZ_LINE2.test(l));

  // The second line starts with a digit (document number) not 'P'
  const line2 = candidates.find(l => /^\d/.test(l) || /^[A-Z]{1,3}\d/.test(l));
  return line2 ?? (candidates.length > 0 ? candidates[0] : null);
}
