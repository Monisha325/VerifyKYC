const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const docs = await prisma.document.findMany({
    orderBy: { createdAt: 'desc' },
    take: 2
  });
  
  const selfie = docs.find(d => d.kind === 'SELFIE');
  const aadhaar = docs.find(d => d.kind === 'AADHAAR');
  
  console.log("SELFIE: " + (selfie ? selfie.cloudinaryUrl : 'none'));
  console.log("AADHAAR: " + (aadhaar ? aadhaar.cloudinaryUrl : 'none'));
  
  await prisma.$disconnect();
}

main().catch(console.error);
