/**
 * VeriKYC database seed — creates the three standard test accounts.
 * Safe to run multiple times: uses upsert so existing accounts are not duplicated.
 *
 * Run: npx ts-node prisma/seed.ts
 *   or: npm run seed
 */

import { hash as argon2Hash } from '@node-rs/argon2';
import { PrismaClient, Role } from '@prisma/client';

const prisma = new PrismaClient();

interface SeedAccount {
  email:    string;
  password: string;
  fullName: string;
  role:     Role;
}

const ACCOUNTS: SeedAccount[] = [
  { email: 'applicant@verikyc.dev', password: 'Test@1234', fullName: 'VeriKYC Applicant',  role: 'APPLICANT' },
  { email: 'reviewer@verikyc.dev',  password: 'Test@1234', fullName: 'VeriKYC Reviewer',   role: 'REVIEWER'  },
  { email: 'admin@verikyc.dev',     password: 'Test@1234', fullName: 'VeriKYC Admin',       role: 'ADMIN'     },
];

async function main() {
  console.log('VeriKYC seed: upserting test accounts…\n');

  for (const account of ACCOUNTS) {
    const passwordHash = await argon2Hash(account.password);

    const user = await prisma.user.upsert({
      where:  { email: account.email },
      update: {
        passwordHash,
        fullName:      account.fullName,
        role:          account.role,
        emailVerified: true,
      },
      create: {
        email:         account.email,
        passwordHash,
        fullName:      account.fullName,
        role:          account.role,
        emailVerified: true,
      },
      select: { id: true, email: true, role: true },
    });

    console.log(`  ${user.role.padEnd(10)} ${user.email}  (id: ${user.id})`);
  }

  console.log('\nSeed complete.');
}

main()
  .catch(err => { console.error('Seed failed:', err); process.exit(1); })
  .finally(() => prisma.$disconnect());
