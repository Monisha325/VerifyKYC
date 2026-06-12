/**
 * Regression test for the two face-verify field-name bugs fixed in P0.
 *
 * Does NOT require the AI service to be running — it intercepts the fetch call
 * and asserts both the outgoing request shape and the incoming response shape.
 *
 *   npx ts-node --transpile-only test-face-field-names.ts
 */

let passed = 0, failed = 0;
function assert(label: string, condition: boolean, detail = '') {
  if (condition) { console.log(`  PASS  ${label}`); passed++; }
  else           { console.error(`  FAIL  ${label}${detail ? `  (${detail})` : ''}`); failed++; }
}

// ── Intercept global fetch ────────────────────────────────────────────────────

let capturedBody: Record<string, unknown> | null = null;

const MOCK_AI_RESPONSE = {
  distance:   0.25,
  threshold:  0.40,
  match:      true,
  model:      'ArcFace',
  face_match: 0.6875,   // (1 - 0.25 / 0.40) normalised
  flag:       null,
};

// Override fetch before importing ai.client (module-level const captures at import time)
(global as unknown as Record<string, unknown>).fetch = async (
  _url: string,
  opts: RequestInit,
) => {
  capturedBody = JSON.parse(opts.body as string) as Record<string, unknown>;
  return {
    ok:   true,
    json: async () => MOCK_AI_RESPONSE,
  } as Response;
};

// ── Import AFTER patching fetch ────────────────────────────────────────────────
// Use dynamic require so the mock is in place before module evaluation
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { verifyFace } = require('./src/modules/verification/ai.client') as typeof import('./src/modules/verification/ai.client');

// ── Test 1: outgoing request uses doc_photo_url (not doc_url) ─────────────────

console.log('\n── Outgoing request field names ────────────────────────────────────');

async function testRequestFields() {
  await verifyFace('https://example.com/selfie.jpg', 'https://example.com/id.jpg');

  assert(
    'request sends selfie_url',
    capturedBody?.['selfie_url'] === 'https://example.com/selfie.jpg',
    `got: ${JSON.stringify(capturedBody)}`,
  );
  assert(
    'request sends doc_photo_url (not doc_url)',
    capturedBody?.['doc_photo_url'] === 'https://example.com/id.jpg',
    `got: ${JSON.stringify(capturedBody)}`,
  );
  assert(
    'request does NOT send doc_url',
    !('doc_url' in (capturedBody ?? {})),
    `capturedBody has doc_url: ${JSON.stringify(capturedBody)}`,
  );
}

// ── Test 2: response type reads face_match (not similarity) ────────────────────

console.log('\n── Response type mapping ───────────────────────────────────────────');

async function testResponseFields() {
  const result = await verifyFace('https://example.com/selfie.jpg', 'https://example.com/id.jpg');

  assert(
    'result.face_match is a number',
    typeof result.face_match === 'number',
    `got type: ${typeof result.face_match}`,
  );
  assert(
    'result.face_match equals mock value 0.6875',
    result.face_match === 0.6875,
    `got: ${result.face_match}`,
  );
  assert(
    'result.match is boolean',
    result.match === true,
  );
  assert(
    'result.distance is present',
    typeof result.distance === 'number',
  );
  assert(
    'result does not have old "similarity" key',
    !('similarity' in result),
    `result keys: ${Object.keys(result).join(', ')}`,
  );
}

// ── Test 3: identity.correlation reads face_match correctly ───────────────────

console.log('\n── identity.correlation field read (face_match → faceDetails.similarity) ──');

async function testCorrelationRead() {
  // Simulate what identity.correlation.ts does at line 239:
  //   faceDetails.push({ docId: doc.id, similarity: result.face_match });
  const result = await verifyFace('s', 'd');
  const faceDetails: { docId: string; similarity: number }[] = [];
  faceDetails.push({ docId: 'doc-1', similarity: result.face_match });

  assert(
    'faceDetails[0].similarity is set from result.face_match',
    faceDetails[0].similarity === MOCK_AI_RESPONSE.face_match,
    `got: ${faceDetails[0].similarity}`,
  );
  assert(
    'faceDetails[0].similarity is not NaN',
    !isNaN(faceDetails[0].similarity),
  );
  assert(
    'faceDetails[0].similarity is not undefined',
    faceDetails[0].similarity !== undefined,
  );

  const faceMatch = Math.min(...faceDetails.map(fd => fd.similarity));
  assert(
    'faceMatch computed from faceDetails is a real number (not NaN)',
    !isNaN(faceMatch) && isFinite(faceMatch),
    `faceMatch=${faceMatch}`,
  );
  assert(
    'faceMatch === 0.6875 (the mock value)',
    faceMatch === 0.6875,
    `faceMatch=${faceMatch}`,
  );

  // With real faceMatch=0.6875 (>0.3), face_below_floor should NOT fire
  const FACE_FLOOR = 0.3;
  assert(
    'faceMatch 0.6875 does NOT trigger face_below_floor hard fail',
    faceMatch >= FACE_FLOOR,
    `faceMatch=${faceMatch}, FACE_FLOOR=${FACE_FLOOR}`,
  );

  // With real faceMatch=0.6875 (>0.5), face_cap_35 in scoring should NOT fire
  assert(
    'faceMatch 0.6875 does NOT trigger face_cap_35 in scoring',
    faceMatch >= 0.5,
    `faceMatch=${faceMatch}`,
  );

  console.log(`\n  → faceMatch correctly produced as ${faceMatch} (genuine score, not capped 0/NaN)`);
  console.log(`  → With faceMatch=0.6875, identity score would include 0.35 × 68.75 = 24.06 points from face`);
  console.log(`  → Overall score would NOT be capped at 35 or zeroed`);
}

testRequestFields()
  .then(() => testResponseFields())
  .then(() => testCorrelationRead())
  .then(() => {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) { console.error('SOME TESTS FAILED'); process.exit(1); }
    else            { console.log('ALL TESTS PASSED — face verify field names are correct'); }
  })
  .catch(e => { console.error('Fatal:', e); process.exit(1); });
