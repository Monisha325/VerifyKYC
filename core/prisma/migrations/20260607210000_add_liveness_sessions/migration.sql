-- CreateTable
CREATE TABLE "liveness_sessions" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "challenges" TEXT[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "liveness_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "liveness_sessions_sessionId_key" ON "liveness_sessions"("sessionId");

-- CreateIndex
CREATE INDEX "liveness_sessions_sessionId_idx" ON "liveness_sessions"("sessionId");

-- CreateIndex
CREATE INDEX "liveness_sessions_userId_idx" ON "liveness_sessions"("userId");
