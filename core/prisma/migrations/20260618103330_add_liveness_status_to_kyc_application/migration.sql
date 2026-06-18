-- AlterTable
ALTER TABLE "kyc_applications" ADD COLUMN     "livenessConfidence" DOUBLE PRECISION,
ADD COLUMN     "livenessVerifiedAt" TIMESTAMP(3);
