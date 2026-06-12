/**
 * End-to-end test: identity correlation + overall scoring.
 *
 * Creates a test application with two govt-ID documents and a selfie,
 * seeds ExtractedField rows with matching identity info, seeds
 * DocumentVerification rows with doc_confidence values, then runs
 * runIdentityCorrelation() → finalize() and prints the results.
 *
 * Run:  npx ts-node-dev test-identity-scoring.ts
 *
 * This script seeds its own data and cleans up after itself.
 */

import dotenv from 'dotenv';
dotenv.config();

import { DocKind, DocStatus, AppStatus, Prisma } from '@prisma/client';
import { prisma }                                 from './src/utils/prisma';
import { runIdentityCorrelation }                 from './src/modules/verification/identity.correlation';
import { finalize }                               from './src/modules/verification/scoring';

// ── Seed data ─────────────────────────────────────────────────────────────────

const SEED_USER = {
  email:        'test-identity@verikyc.dev',
  passwordHash: '$argon2id$test$placeholder',
  fullName:     'Test Identity User',
};

const AADHAAR_FIELDS: Record<string, string> = {
  identifier: '234567890123',
  name:       'RAJESH KUMAR SHARMA',
  dob:        '15/08/1990',
  gender:     'Male',
  address:    '42 MG Road, Apt 5B, Koramangala, Bengaluru, Karnataka 560034',
};

const PAN_FIELDS: Record<string, string> = {
  identifier: 'ABCPK1234A',
  name:       'RAJESH K SHARMA',     // slight variation — fuzzy match should handle
  dob:        '15/08/1990',          // exact match
};

const SELFIE_URL = 'https://res.cloudinary.com/demo/image/upload/v1/test/selfie.jpg';
const AADHAAR_URL = 'https://res.cloudinary.com/demo/image/upload/v1/test/aadhaar.jpg';
const PAN_URL     = 'https://res.cloudinary.com/demo/image/upload/v1/test/pan.jpg';

// Simulated doc_confidence scores from the per-document pipeline
const AADHAAR_DOC_CONFIDENCE = 78;
const PAN_DOC_CONFIDENCE     = 82;

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  VeriKYC — Identity Correlation + Scoring Test');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Clean up any prior test run
  const existingUser = await prisma.user.findUnique({ where: { email: SEED_USER.email } });
  if (existingUser) {
    await prisma.user.delete({ where: { id: existingUser.id } });
    console.log('[cleanup] deleted prior test user + cascade\n');
  }

  // 1. Create user
  const user = await prisma.user.create({ data: SEED_USER });
  console.log(`[seed] user created: ${user.id}`);

  // 2. Create application
  const app = await prisma.kycApplication.create({
    data: { userId: user.id, status: AppStatus.PROCESSING, submittedAt: new Date() },
  });
  console.log(`[seed] application created: ${app.id}`);

  // 3. Create documents: Aadhaar, PAN, Selfie
  const aadhaarDoc = await prisma.document.create({
    data: {
      applicationId: app.id, kind: DocKind.AADHAAR,
      status: DocStatus.VERIFIED, cloudinaryUrl: AADHAAR_URL, uploadedAt: new Date(),
    },
  });
  console.log(`[seed] aadhaar doc: ${aadhaarDoc.id}`);

  const panDoc = await prisma.document.create({
    data: {
      applicationId: app.id, kind: DocKind.PAN,
      status: DocStatus.VERIFIED, cloudinaryUrl: PAN_URL, uploadedAt: new Date(),
    },
  });
  console.log(`[seed] pan doc: ${panDoc.id}`);

  const selfieDoc = await prisma.document.create({
    data: {
      applicationId: app.id, kind: DocKind.SELFIE,
      status: DocStatus.VERIFIED, cloudinaryUrl: SELFIE_URL, uploadedAt: new Date(),
    },
  });
  console.log(`[seed] selfie doc: ${selfieDoc.id}`);

  // 4. Seed ExtractedField rows for Aadhaar
  for (const [fieldName, fieldValue] of Object.entries(AADHAAR_FIELDS)) {
    await prisma.extractedField.create({
      data: { documentId: aadhaarDoc.id, fieldName, fieldValue, confidence: 0.85, source: 'structured' },
    });
  }
  console.log(`[seed] aadhaar fields: ${Object.keys(AADHAAR_FIELDS).join(', ')}`);

  // 5. Seed ExtractedField rows for PAN
  for (const [fieldName, fieldValue] of Object.entries(PAN_FIELDS)) {
    await prisma.extractedField.create({
      data: { documentId: panDoc.id, fieldName, fieldValue, confidence: 0.80, source: 'structured' },
    });
  }
  console.log(`[seed] pan fields: ${Object.keys(PAN_FIELDS).join(', ')}`);

  // 6. Seed DocumentVerification rows with doc_confidence values
  await prisma.documentVerification.create({
    data: {
      documentId: aadhaarDoc.id,
      ocrConfidence: 0.88,
      isAuthentic: true,
      fraudScore: 0.05,
      rawAiResponse: {
        doc_confidence: AADHAAR_DOC_CONFIDENCE,
        flags: [],
        stages: { quality: true, ocr: true, classify: true, authenticity: true, fieldValidation: true, fraud: true },
      } as Prisma.InputJsonValue,
      verifiedAt: new Date(),
    },
  });

  await prisma.documentVerification.create({
    data: {
      documentId: panDoc.id,
      ocrConfidence: 0.92,
      isAuthentic: true,
      fraudScore: 0.03,
      rawAiResponse: {
        doc_confidence: PAN_DOC_CONFIDENCE,
        flags: [],
        stages: { quality: true, ocr: true, classify: true, authenticity: true, fieldValidation: true, fraud: true },
      } as Prisma.InputJsonValue,
      verifiedAt: new Date(),
    },
  });

  // Selfie verification (minimal — selfies don't have a fraud pipeline)
  await prisma.documentVerification.create({
    data: {
      documentId: selfieDoc.id,
      ocrConfidence: null,
      isAuthentic: true,
      fraudScore: 0,
      rawAiResponse: {
        doc_confidence: 60,
        flags: [],
        stages: { quality: true },
      } as Prisma.InputJsonValue,
      verifiedAt: new Date(),
    },
  });

  console.log(`[seed] document verifications created\n`);

  // ═══════════════════════════════════════════════════════════════════════════
  // RUN identity correlation + scoring
  // ═══════════════════════════════════════════════════════════════════════════

  console.log('─── Running Identity Correlation ────────────────────────\n');
  const identityResult = await runIdentityCorrelation(app.id);

  console.log('\n─── Running Overall Scoring ─────────────────────────────\n');
  const { overallScore, band } = await finalize(app.id, identityResult);

  // ═══════════════════════════════════════════════════════════════════════════
  // PRINT RESULTS
  // ═══════════════════════════════════════════════════════════════════════════

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('                    RESULTS');
  console.log('═══════════════════════════════════════════════════════════\n');

  console.log('Identity Sub-Matches:');
  console.log(`  nameMatch:      ${identityResult.nameMatch.toFixed(4)}  (token_sort_ratio)`);
  console.log(`  dobMatch:       ${identityResult.dobMatch}`);
  console.log(`  genderMatch:    ${identityResult.genderMatch}`);
  console.log(`  addressMatch:   ${identityResult.addressMatch.toFixed(4)}  (token_set_ratio)`);
  console.log(`  faceMatch:      ${identityResult.faceMatch.toFixed(4)}  (MIN of face verifications)`);
  console.log(`  identityScore:  ${identityResult.identityScore}`);
  console.log(`  hardFails:      [${identityResult.hardFails.join(', ')}]`);

  if (identityResult.faceDetails.length > 0) {
    console.log(`  faceDetails:`);
    for (const fd of identityResult.faceDetails) {
      console.log(`    - doc ${fd.docId}: similarity=${fd.similarity.toFixed(4)}`);
    }
  }

  console.log('');
  console.log('Overall:');
  console.log(`  overallScore:   ${overallScore}`);
  console.log(`  band:           ${band}`);

  // Fetch persisted data to confirm
  const finalApp = await prisma.kycApplication.findUnique({
    where: { id: app.id },
    select: { overallScore: true, scoreBand: true, status: true },
  });
  const correlation = await prisma.identityCorrelation.findUnique({
    where: { applicationId: app.id },
  });

  console.log('');
  console.log('Persisted (DB):');
  console.log(`  kycApplication.overallScore: ${finalApp?.overallScore}`);
  console.log(`  kycApplication.scoreBand:    ${finalApp?.scoreBand}`);
  console.log(`  kycApplication.status:       ${finalApp?.status}`);
  console.log(`  identityCorrelation.id:      ${correlation?.id}`);
  console.log(`  identityCorrelation.overall: ${correlation?.overallScore}`);
  console.log(`  identityCorrelation.face:    ${correlation?.faceMatchScore}`);
  console.log(`  identityCorrelation.name:    ${correlation?.nameMatchScore}`);
  console.log(`  identityCorrelation.dob:     ${correlation?.dobMatchScore}`);
  console.log(`  identityCorrelation.corr:    ${correlation?.isCorrelated}`);

  // Audit events
  const audits = await prisma.auditEvent.findMany({
    where: { applicationId: app.id, action: { in: ['IDENTITY_CORRELATED', 'AUTO_SCORED', 'FACE_VERIFICATION_UNAVAILABLE'] } },
    orderBy: { createdAt: 'asc' },
    select: { action: true, meta: true, createdAt: true },
  });
  console.log('');
  console.log('Audit Events:');
  for (const ev of audits) {
    console.log(`  ${ev.action} at ${ev.createdAt.toISOString()}`);
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  TEST COMPLETE');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Cleanup
  await prisma.user.delete({ where: { id: user.id } });
  console.log('[cleanup] test data removed\n');

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('TEST FAILED:', err);
  await prisma.$disconnect();
  process.exit(1);
});
