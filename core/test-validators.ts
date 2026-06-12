/**
 * Stage 4 unit tests — run without a database or AI service.
 *
 *   npx ts-node --transpile-only test-validators.ts
 *
 * Covers:
 *   - Verhoeff checksum (AADHAAR)
 *   - PAN regex
 *   - MRZ ICAO 9303 check-digit computation
 *   - Full MRZ line-2 validation (pass + fail cases)
 *   - MockRegistryProvider end-to-end
 *   - field.extractor structured-field extraction
 */

import { verhoeffValid, panValid, mrzCheckDigit, validateMrz, parseMrzLine2 }
  from './src/modules/verification/document.validators';
import { MockRegistryProvider }
  from './src/modules/verification/registry.provider';
import { extractFields }
  from './src/modules/verification/field.extractor';
import { DocKind } from '@prisma/client';

// ── Test harness ──────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
function assert(label: string, condition: boolean, detail = '') {
  if (condition) { console.log(`  PASS  ${label}`); passed++; }
  else           { console.error(`  FAIL  ${label}${detail ? `  (${detail})` : ''}`); failed++; }
}
function section(name: string) { console.log(`\n── ${name} ${'─'.repeat(50 - name.length)}`); }

// ─────────────────────────────────────────────────────────────────────────────
// Verhoeff
// ─────────────────────────────────────────────────────────────────────────────
section('Verhoeff (AADHAAR)');

// Known-valid Aadhaar numbers (publicly documented test values)
assert('valid: 234123412346',   verhoeffValid('234123412346'));
assert('valid: with spaces 2341 2341 2346', verhoeffValid('2341 2341 2346'));

// Invalid: flip last digit
assert('invalid: 234123412347 (bad check)',  !verhoeffValid('234123412347'));
assert('invalid: 000000000000',              !verhoeffValid('000000000000'));
assert('invalid: too short (11 digits)',     !verhoeffValid('12345678901'));
assert('invalid: too long (13 digits)',      !verhoeffValid('1234567890123'));
assert('invalid: non-numeric',               !verhoeffValid('ABCDEFGHIJKL'));

// ─────────────────────────────────────────────────────────────────────────────
// PAN regex
// ─────────────────────────────────────────────────────────────────────────────
section('PAN regex');

// Valid PANs (real-format examples)
assert('valid: ABCPD1234E',  panValid('ABCPD1234E'));
assert('valid: AAAPL1234C',  panValid('AAAPL1234C'));
assert('valid: AFZPK7190K',  panValid('AFZPK7190K'));
assert('valid: lowercase normalised', panValid('abcpd1234e'));  // extractor upper-cases

// Invalid PANs
assert('invalid: wrong 4th char (D not in set)',   !panValid('ABCDD1234E'));
assert('invalid: too short',                        !panValid('ABCPD123E'));
assert('invalid: too long',                         !panValid('ABCPD12345E'));
assert('invalid: digit where letter expected',      !panValid('ABC1D1234E'));
assert('invalid: letter where digit expected',      !panValid('ABCPDA234E'));

// ─────────────────────────────────────────────────────────────────────────────
// MRZ check-digit computation
// ─────────────────────────────────────────────────────────────────────────────
section('mrzCheckDigit (ICAO 9303 7-3-1)');

// Manual ICAO 9303 reference computations:
//   "PA1234567": P(25)×7 + A(10)×3 + 1×1 + 2×7 + 3×3 + 4×1 + 5×7 + 6×3 + 7×1 = 293 mod 10 = 3
//   "19770415":  1×7 + 9×3 + 7×1 + 7×7 + 0×3 + 4×1 + 1×7 + 5×3               = 116 mod 10 = 6
//   "991231":    9×7 + 9×3 + 1×1 + 2×7 + 3×3 + 1×1                            = 115 mod 10 = 5
assert('check("PA1234567")==3',       mrzCheckDigit('PA1234567') === 3, `got ${mrzCheckDigit('PA1234567')}`);
assert('check("19770415")==6',         mrzCheckDigit('19770415') === 6, `got ${mrzCheckDigit('19770415')}`);
assert('check("991231")==5',           mrzCheckDigit('991231')   === 5, `got ${mrzCheckDigit('991231')}`);
assert('check("<<<<<<<<<<<<<<") == 0', mrzCheckDigit('<<<<<<<<<<<<<<') === 0);
assert('check("A") == 10*7 mod 10 = 0', mrzCheckDigit('A') === 0);
assert('check("B") == 11*7 mod 10 = 7', mrzCheckDigit('B') === 7);

// ─────────────────────────────────────────────────────────────────────────────
// Full MRZ validation
// ─────────────────────────────────────────────────────────────────────────────
section('validateMrz — TD3 line 2');

/**
 * Build a synthetic TD3 MRZ line 2 from components and insert real check digits.
 * This guarantees we test the validator with internally-consistent data.
 */
function buildMrzLine2(
  docNo: string,   // 9 chars
  nat:   string,   // 3 chars
  dob:   string,   // YYMMDD
  sex:   string,   // 1 char
  exp:   string,   // YYMMDD
  pno:   string,   // 14 chars (pad with '<')
): string {
  const { mrzCheckDigit: cd } = require('./src/modules/verification/document.validators');
  const d  = docNo.padEnd(9, '<').slice(0, 9);
  const n  = nat.padEnd(3, '<').slice(0, 3);
  const p  = pno.padEnd(14, '<').slice(0, 14);
  const c1 = cd(d);
  const c2 = cd(dob);
  const c3 = cd(exp);
  const c4 = cd(p);
  // ICAO 9303 Part 3: composite covers positions 0-9, 13-19, 21-42 (0-indexed).
  // Position 20 (sex) is explicitly NOT included in the composite.
  const composite = d + String(c1) + dob + String(c2) + exp + String(c3) + p + String(c4);
  const c5 = cd(composite);
  return `${d}${c1}${n}${dob}${c2}${sex}${exp}${c3}${p}${c4}${c5}`;
}

const validLine2 = buildMrzLine2('PA1234567', 'IND', '800101', 'M', '301231', '');
assert('valid line2 passes all 5 checks',     validateMrz(validLine2).valid,
       `failedChecks=${validateMrz(validLine2).failedChecks.join(',')}`);
assert('docNumber extracted correctly',       validateMrz(validLine2).docNumber === 'PA1234567');
assert('nationality extracted',               validateMrz(validLine2).nationality === 'IND');
assert('sex extracted',                       validateMrz(validLine2).sex === 'M');

// Tamper line: flip one digit → should fail
const tampered = validLine2.slice(0, 5) + String((parseInt(validLine2[5]) + 1) % 10) + validLine2.slice(6);
assert('tampered line2 fails',                !validateMrz(tampered).valid);

// Wrong length
assert('wrong length fails',                  !validateMrz('TOOSHORT').valid);

// ─────────────────────────────────────────────────────────────────────────────
// parseMrzLine2 — extraction from OCR text
// ─────────────────────────────────────────────────────────────────────────────
section('parseMrzLine2');

const ocrWithMrz = `REPUBLIC OF INDIA
PASSPORT
P<INDSMITH<<JOHN<<<<<<<<<<<<<<<<<<<<<<<<<<
${validLine2}
Date of Issue: 01/01/2020`;

const extracted = parseMrzLine2(ocrWithMrz);
assert('finds MRZ line2 in OCR text',         extracted === validLine2, `got: ${extracted}`);
assert('parseMrzLine2(plain text) → null',    parseMrzLine2('hello world') === null);

// ─────────────────────────────────────────────────────────────────────────────
// MockRegistryProvider
// ─────────────────────────────────────────────────────────────────────────────
section('MockRegistryProvider');

const provider = new MockRegistryProvider();

async function runProviderTests() {
  // AADHAAR — valid Verhoeff number
  const aa = await provider.verify(DocKind.AADHAAR, '', { identifier: '234123412346' });
  assert('AADHAAR valid: score > 0 and passed',      aa.passed && aa.score > 0,
         `score=${aa.score} passed=${aa.passed} flags=${aa.flags}`);
  assert('AADHAAR valid: no checksum_fail flag',      !aa.flags.includes('checksum_fail'));

  // AADHAAR — invalid
  const ab = await provider.verify(DocKind.AADHAAR, '', { identifier: '234123412347' });
  assert('AADHAAR invalid: not passed',               !ab.passed, `score=${ab.score}`);
  assert('AADHAAR invalid: checksum_fail flag',       ab.flags.includes('checksum_fail'));

  // PAN — valid
  const pa = await provider.verify(DocKind.PAN, '', { identifier: 'ABCPD1234E' });
  assert('PAN valid: passed',                         pa.passed, `score=${pa.score}`);

  // PAN — invalid
  const pb = await provider.verify(DocKind.PAN, '', { identifier: 'INVALID' });
  assert('PAN invalid: not passed',                   !pb.passed);

  // PASSPORT — valid MRZ in OCR
  const passOcr = `P<INDSMITH<<JOHN<<<<<<<<<<<\n${validLine2}`;
  const ps = await provider.verify(DocKind.PASSPORT, passOcr, {});
  assert('PASSPORT valid MRZ: passed',                ps.passed, `failedChecks=${JSON.stringify(ps.details)}`);

  // PASSPORT — no MRZ at all
  const pn = await provider.verify(DocKind.PASSPORT, 'just some text', {});
  assert('PASSPORT no MRZ: not passed',               !pn.passed);
  assert('PASSPORT no MRZ: mrz_fail flag',            pn.flags.includes('mrz_fail'));

  // SELFIE — always ok
  const sf = await provider.verify(DocKind.SELFIE, '', {});
  assert('SELFIE: passed',                            sf.passed);

  // Determinism: same identifier → same score
  const s1 = await provider.verify(DocKind.AADHAAR, '', { identifier: '234123412346' });
  const s2 = await provider.verify(DocKind.AADHAAR, '', { identifier: '234123412346' });
  assert('MockRegistry is deterministic',             s1.score === s2.score);
}

// ─────────────────────────────────────────────────────────────────────────────
// field.extractor
// ─────────────────────────────────────────────────────────────────────────────
section('field.extractor');

const aadhaarOcr = `
Unique Identification Authority of India
RAHUL KUMAR
DOB: 15/08/1990
Male
1234 5678 9012
Address: 123 MG Road, Bangalore 560001
`;
const aaRes = extractFields(DocKind.AADHAAR, aadhaarOcr);
assert('AADHAAR: identifier extracted',    !!aaRes.fields.identifier,  `got: ${aaRes.fields.identifier}`);
assert('AADHAAR: identifier = 14 chars (masked)',  aaRes.fields.identifier?.length === 14);
assert('AADHAAR: dob extracted',           !!aaRes.fields.dob,         `got: ${aaRes.fields.dob}`);
assert('AADHAAR: completeness > 0',        aaRes.field_completeness > 0);

const panOcr = `INCOME TAX DEPARTMENT\nPERMANENT ACCOUNT NUMBER\nABCPD1234E\nRAHUL KUMAR\nF/O SURESH KUMAR`;
const panRes = extractFields(DocKind.PAN, panOcr);
assert('PAN: identifier extracted',        !!panRes.fields.identifier, `got: ${panRes.fields.identifier}`);
assert('PAN: identifier looks like PAN',   /^[A-Z]{5}\d{4}[A-Z]$/.test(panRes.fields.identifier ?? ''));

const passOcr2 = `REPUBLIC OF INDIA\nPASSPORT\nP<INDSMITH<<JOHN<<<<<\n${validLine2}`;
const ppRes = extractFields(DocKind.PASSPORT, passOcr2);
assert('PASSPORT: mrz_line2 found',        !!ppRes.fields.mrz_line2);
assert('PASSPORT: identifier from MRZ',    !!ppRes.fields.identifier);
assert('PASSPORT: dob from MRZ',           !!ppRes.fields.dob);

// Run async tests then print summary
runProviderTests().then(() => {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) { console.error('SOME TESTS FAILED'); process.exit(1); }
  else            { console.log('ALL TESTS PASSED'); }
}).catch(e => { console.error('Fatal:', e); process.exit(1); });
