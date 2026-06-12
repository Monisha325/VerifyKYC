const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const apps = await prisma.kycApplication.findMany({
    orderBy: { createdAt: 'desc' },
    take: 1,
    include: {
      identityCorrelation: true,
      documents: {
        include: { documentVerification: true }
      }
    }
  });

  const app = apps[0];
  console.log("IDENTITY CORRELATION:");
  console.log(JSON.stringify(app.identityCorrelation, null, 2));

  console.log("\nDOCUMENTS:");
  for (const doc of app.documents) {
    console.log(`- ${doc.kind} (Status: ${doc.status})`);
    if (doc.documentVerification) {
      console.log(`  Confidence: ${doc.documentVerification.ocrConfidence}`);
      console.log(`  Raw Response:`, JSON.stringify(doc.documentVerification.rawAiResponse, null, 2));
    }
  }

  await prisma.$disconnect();
}

main().catch(console.error);
