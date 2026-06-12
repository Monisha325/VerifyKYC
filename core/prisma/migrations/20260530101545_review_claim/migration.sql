-- DropIndex
DROP INDEX "review_decisions_applicationId_key";

-- AlterTable
ALTER TABLE "kyc_applications" ADD COLUMN     "claimedAt" TIMESTAMP(3),
ADD COLUMN     "claimedById" TEXT;

-- AlterTable
ALTER TABLE "review_decisions" ADD COLUMN     "reasonCodes" TEXT[];

-- CreateIndex
CREATE INDEX "audit_events_entity_entityId_idx" ON "audit_events"("entity", "entityId");

-- CreateIndex
CREATE INDEX "kyc_applications_claimedById_idx" ON "kyc_applications"("claimedById");

-- CreateIndex
CREATE INDEX "review_decisions_applicationId_idx" ON "review_decisions"("applicationId");

-- AddForeignKey
ALTER TABLE "kyc_applications" ADD CONSTRAINT "kyc_applications_claimedById_fkey" FOREIGN KEY ("claimedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
