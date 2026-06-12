import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Seeded accounts that must never be deleted
const KEEP_EMAILS = [
  'applicant@verikyc.dev',
  'reviewer@verikyc.dev',
  'admin@verikyc.dev',
];

async function main() {
  console.log('\n=== Step 1: All users before deletion ===');
  const all = await prisma.user.findMany({
    select: { id: true, email: true, role: true, emailVerified: true },
    orderBy: { createdAt: 'asc' },
  });
  all.forEach(u => console.log(`  ${u.role.padEnd(10)} ${u.email}`));
  console.log(`  Total: ${all.length}`);

  const toDelete = all.filter(u => !KEEP_EMAILS.includes(u.email));
  if (toDelete.length === 0) {
    console.log('\n  No non-seeded accounts to delete.');
    return;
  }

  const userIds = toDelete.map(u => u.id);
  console.log(`\n  Deleting ${toDelete.length} non-seeded account(s):`);
  toDelete.forEach(u => console.log(`    - ${u.email}`));

  const apps = await prisma.kycApplication.findMany({
    where: { userId: { in: userIds } }, select: { id: true },
  });
  const appIds = apps.map(a => a.id);

  const docs = await prisma.document.findMany({
    where: { applicationId: { in: appIds } }, select: { id: true },
  });
  const docIds = docs.map(d => d.id);

  console.log(`\n=== Step 2: Deleting related data (children before parents) ===`);

  // Depth 3 — grandchildren of KycApplication (children of Document)
  const ef = await prisma.extractedField.deleteMany({ where: { documentId: { in: docIds } } });
  console.log(`  ExtractedField:       ${ef.count}`);

  const dv = await prisma.documentVerification.deleteMany({ where: { documentId: { in: docIds } } });
  console.log(`  DocumentVerification: ${dv.count}`);

  // Depth 2 — direct children of KycApplication
  // reviewDecision has a RESTRICT FK to users.reviewerId — must be gone before User rows are deleted
  const rd = await prisma.reviewDecision.deleteMany({ where: { applicationId: { in: appIds } } });
  console.log(`  ReviewDecision:       ${rd.count}`);

  const ic = await prisma.identityCorrelation.deleteMany({ where: { applicationId: { in: appIds } } });
  console.log(`  IdentityCorrelation:  ${ic.count}`);

  const doc = await prisma.document.deleteMany({ where: { applicationId: { in: appIds } } });
  console.log(`  Document:             ${doc.count}`);

  // AuditEvent: actorId → users (SET NULL) and applicationId → kyc_applications (SET NULL).
  // Delete explicitly to keep the audit log clean; filter by both FK columns so events
  // with applicationId = null (login, registration) are also removed for these users.
  const ae = await prisma.auditEvent.deleteMany({
    where: { OR: [{ applicationId: { in: appIds } }, { actorId: { in: userIds } }] },
  });
  console.log(`  AuditEvent:           ${ae.count}`);

  // Depth 1 — direct children of User
  const ev = await prisma.emailVerification.deleteMany({ where: { userId: { in: userIds } } });
  console.log(`  EmailVerification:    ${ev.count}`);

  const rt = await prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
  console.log(`  RefreshToken:         ${rt.count}`);

  const app = await prisma.kycApplication.deleteMany({ where: { userId: { in: userIds } } });
  console.log(`  KycApplication:       ${app.count}`);

  // Root
  const usr = await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  console.log(`  User:                 ${usr.count}`);

  console.log('\n=== Step 3: Remaining users (seeded only) ===');
  const remaining = await prisma.user.findMany({
    select: { email: true, role: true, emailVerified: true },
    orderBy: { role: 'asc' },
  });
  console.log(`  Total: ${remaining.length}`);
  remaining.forEach(u =>
    console.log(`  ${u.role.padEnd(10)} emailVerified=${u.emailVerified} ${u.email}`)
  );
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
