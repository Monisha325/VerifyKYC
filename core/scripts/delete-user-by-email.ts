import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const TARGET_EMAIL = process.argv[2];
if (!TARGET_EMAIL) { console.error('Usage: npx ts-node scripts/delete-user-by-email.ts <email>'); process.exit(1); }

async function main() {
  const user = await prisma.user.findUnique({
    where:  { email: TARGET_EMAIL },
    select: { id: true, email: true, role: true },
  });

  if (!user) {
    console.log(`No user found with email: ${TARGET_EMAIL}`);
    return;
  }

  console.log(`Found: [${user.role}] ${user.email} (id: ${user.id})`);
  console.log('Deleting cascade...\n');

  const apps = await prisma.kycApplication.findMany({
    where:  { userId: user.id },
    select: { id: true },
  });
  const appIds = apps.map(a => a.id);

  const docs = await prisma.document.findMany({
    where:  { applicationId: { in: appIds } },
    select: { id: true },
  });
  const docIds = docs.map(d => d.id);

  const ev  = await prisma.emailVerification.deleteMany({ where: { userId: user.id } });
  console.log(`  EmailVerification:    ${ev.count}`);

  const ae  = await prisma.auditEvent.deleteMany({ where: { applicationId: { in: appIds } } });
  console.log(`  AuditEvent:           ${ae.count}`);

  const rd  = await prisma.reviewDecision.deleteMany({ where: { applicationId: { in: appIds } } });
  console.log(`  ReviewDecision:       ${rd.count}`);

  const ic  = await prisma.identityCorrelation.deleteMany({ where: { applicationId: { in: appIds } } });
  console.log(`  IdentityCorrelation:  ${ic.count}`);

  const dv  = await prisma.documentVerification.deleteMany({ where: { documentId: { in: docIds } } });
  console.log(`  DocumentVerification: ${dv.count}`);

  const ef  = await prisma.extractedField.deleteMany({ where: { documentId: { in: docIds } } });
  console.log(`  ExtractedField:       ${ef.count}`);

  const doc = await prisma.document.deleteMany({ where: { applicationId: { in: appIds } } });
  console.log(`  Document:             ${doc.count}`);

  const app = await prisma.kycApplication.deleteMany({ where: { userId: user.id } });
  console.log(`  KycApplication:       ${app.count}`);

  const rt  = await prisma.refreshToken.deleteMany({ where: { userId: user.id } });
  console.log(`  RefreshToken:         ${rt.count}`);

  await prisma.user.delete({ where: { id: user.id } });
  console.log(`  User:                 1`);

  console.log(`\nDone — ${TARGET_EMAIL} deleted.`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
