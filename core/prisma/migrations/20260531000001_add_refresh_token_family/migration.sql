-- Migration: add family column to refresh_tokens
-- Purpose: enables token-family-scoped reuse detection (claw.md Phase B #8).
--          When a revoked token is replayed, all tokens in the same family
--          are immediately revoked instead of only all user tokens.

ALTER TABLE "refresh_tokens" ADD COLUMN "family" TEXT NOT NULL DEFAULT '';

-- Back-fill existing rows: each row becomes its own family (singleton families
-- for pre-existing tokens; they will be naturally replaced on next rotation).
UPDATE "refresh_tokens" SET "family" = id WHERE "family" = '';

CREATE INDEX "refresh_tokens_family_idx" ON "refresh_tokens"("family");
