/**
 * RegistryProvider — abstraction over government document registries.
 *
 * Production implementations swap in real UIDAI / NSDL / Passport Seva APIs.
 * MockRegistryProvider ships for local dev + CI: it runs pure local validators
 * (Verhoeff checksum, PAN regex, MRZ check digits) and produces a deterministic
 * authenticity score keyed off the identifier, so tests are reproducible.
 *
 * Usage in pipeline:
 *   const provider = new MockRegistryProvider();
 *   const result   = await provider.verify('AADHAAR', ocrText, extractedFields);
 */

import { DocKind } from '@prisma/client';
import {
  verhoeffValid,
  panValid,
  parseMrzLine2,
  validateMrz,
} from './document.validators';

// ── Public types ──────────────────────────────────────────────────────────────

export interface AuthenticityResult {
  score:       number;                   // 0..100
  passed:      boolean;
  method:      string;                   // "verhoeff" | "regex" | "mrz_icao" | "format_check" | "mock"
  identifier:  string | null;            // normalized identifier found in text
  details:     Record<string, unknown>;
  flags:       string[];                 // machine-readable failure codes
}

export interface RegistryProvider {
  verify(
    kind:            DocKind,
    ocrText:         string,
    extractedFields: Record<string, string>,
  ): Promise<AuthenticityResult>;
}

// ── MockRegistryProvider ──────────────────────────────────────────────────────

export class MockRegistryProvider implements RegistryProvider {
  async verify(
    kind:            DocKind,
    ocrText:         string,
    extractedFields: Record<string, string>,
  ): Promise<AuthenticityResult> {
    switch (kind) {
      case DocKind.AADHAAR:          return this._aadhaar(extractedFields);
      case DocKind.PAN:              return this._pan(extractedFields);
      case DocKind.PASSPORT:         return this._passport(ocrText, extractedFields);
      case DocKind.DRIVING_LICENCE:  return this._drivingLicence(extractedFields);
      case DocKind.SELFIE:
        // Selfies are not government documents — no checksum to validate
        return { score: 60, passed: true, method: 'mock', identifier: null,
                 details: { note: 'selfie — no registry check' }, flags: [] };
      default:
        return { score: 0, passed: false, method: 'mock', identifier: null,
                 details: { reason: 'unknown_doc_kind' }, flags: ['unknown_kind'] };
    }
  }

  // ── AADHAAR — Verhoeff checksum ─────────────────────────────────────────────

  private _aadhaar(fields: Record<string, string>): AuthenticityResult {
    const raw = (fields['aadhaar_number'] ?? fields['identifier'] ?? '').replace(/\D/g, '');

    if (raw.length !== 12) {
      return { score: 0, passed: false, method: 'verhoeff', identifier: raw || null,
               details: { reason: 'not_12_digits', found: raw.length },
               flags: ['checksum_fail'] };
    }

    const ok = verhoeffValid(raw);
    // Compliance: never persist or return the full Aadhaar number.
    // Expose only the masked last-4 digits (safe reference).
    const maskedId = `XXXX XXXX ${raw.slice(8, 12)}`;
    return {
      score:      ok ? this._deterministicScore(raw, 70) : 0,
      passed:     ok,
      method:     'verhoeff',
      identifier: maskedId,
      details:    { checksumPassed: ok },
      flags:      ok ? [] : ['checksum_fail'],
    };
  }

  // ── PAN — Regex ─────────────────────────────────────────────────────────────

  private _pan(fields: Record<string, string>): AuthenticityResult {
    const raw = (fields['pan_number'] ?? fields['identifier'] ?? '').trim().toUpperCase();

    if (!raw) {
      return { score: 0, passed: false, method: 'regex', identifier: null,
               details: { reason: 'identifier_not_found' }, flags: ['checksum_fail'] };
    }

    const ok = panValid(raw);
    return {
      score:      ok ? this._deterministicScore(raw, 70) : 0,
      passed:     ok,
      method:     'regex',
      identifier: raw,
      details:    { regexPassed: ok, pattern: '^[A-Z]{3}[ABCFGHLJPTK][A-Z]\\d{4}[A-Z]$' },
      flags:      ok ? [] : ['checksum_fail'],
    };
  }

  // ── PASSPORT — ICAO 9303 MRZ check digits ──────────────────────────────────

  private _passport(ocrText: string, fields: Record<string, string>): AuthenticityResult {
    const mrzRaw = fields['mrz_line2'] ?? parseMrzLine2(ocrText) ?? '';

    if (!mrzRaw) {
      return { score: 20, passed: false, method: 'mrz_icao', identifier: null,
               details: { reason: 'mrz_not_found' }, flags: ['mrz_fail'] };
    }

    const result = validateMrz(mrzRaw);

    if (!result.valid) {
      // Partial credit: each passing check adds some confidence
      const passedCount = result.checksValid.filter(Boolean).length;
      const partialScore = Math.round((passedCount / 5) * 40); // max 40 for partial
      return {
        score:      partialScore,
        passed:     false,
        method:     'mrz_icao',
        identifier: result.docNumber || null,
        details:    { checksValid: result.checksValid, failedChecks: result.failedChecks },
        flags:      ['mrz_fail'],
      };
    }

    return {
      score:      this._deterministicScore(result.docNumber, 75),
      passed:     true,
      method:     'mrz_icao',
      identifier: result.docNumber,
      details: {
        checksValid:  result.checksValid,
        nationality:  result.nationality,
        dob:          result.dob,
        expiry:       result.expiry,
        sex:          result.sex,
      },
      flags: [],
    };
  }

  // ── Driving Licence — basic format ──────────────────────────────────────────

  private _drivingLicence(fields: Record<string, string>): AuthenticityResult {
    // Indian DL format: SS-RR-YYYY-NNNNNNN  (state-RTO-year-serial)
    const raw = (fields['dl_number'] ?? fields['identifier'] ?? '').trim().toUpperCase();
    const DL_RE = /^[A-Z]{2}[\s-]?\d{2}[\s-]?\d{4}[\s-]?\d{7}$/;
    const ok = DL_RE.test(raw.replace(/\s/g, ''));

    return {
      score:      ok ? this._deterministicScore(raw, 60) : 30,
      passed:     ok,
      method:     'format_check',
      identifier: raw || null,
      details:    { formatPassed: ok, note: 'state-RTO-year-serial pattern' },
      // DL format failures are not hard fraud signals — format varies by state
      flags:      [],
    };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Deterministic score in [base, 100] keyed off the identifier string.
   * Simulates the variation a real registry lookup would produce.
   */
  private _deterministicScore(identifier: string, base: number): number {
    let h = 0;
    for (const ch of identifier) h = Math.imul(h * 31 + ch.charCodeAt(0), 1) >>> 0;
    return base + (h % (101 - base));
  }
}
