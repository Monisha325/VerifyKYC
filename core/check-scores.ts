import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function check() {
  const app = await prisma.kycApplication.findFirst({
    orderBy: { createdAt: 'desc' },
    include: {
      documents: {
        include: { documentVerification: true }
      }
    }
  });

  if (!app) {
    console.log("No applications found.");
    return;
  }

  console.log(`\n=== Latest Application: ${app.id} ===`);
  console.log(`Overall Score: ${app.overallScore}`);
  console.log(`Score Band:    ${app.scoreBand}`);
  console.log(`Status:        ${app.status}`);
  console.log(`\nDocuments:`);

  app.documents.forEach(doc => {
    const raw = doc.documentVerification?.rawAiResponse as any;
    console.log(`- ${doc.kind.padEnd(10)}: Score = ${raw?.doc_confidence ?? 'N/A'}`);
    console.log(`  Path: ${raw?.verification_path}`);
    if (raw?.signals?.confidence) {
        console.log(`  Confidence Math: auth=${raw.signals.confidence.authenticityScore}, fraud=${raw.signals.confidence.fraudScore}, field=${raw.signals.confidence.field_completeness}, ocr=${raw.signals.confidence.ocr_quality}, mult=${raw.signals.confidence.quality_gate_multiplier}`);
        console.log(`  Flags: ${raw.flags}`);
        console.log(`  ocrError: ${raw.signals.ocrError}`);
    }
  });

  const audits = await prisma.auditEvent.findMany({
      where: { applicationId: app.id, action: 'AUTO_SCORED' }
  });
  if (audits.length > 0) {
      console.log(`\nAudit Logs:`, JSON.stringify(audits[0].meta, null, 2));
  }

  console.log("===================================\n");
  process.exit(0);
}

check().catch(console.error);
