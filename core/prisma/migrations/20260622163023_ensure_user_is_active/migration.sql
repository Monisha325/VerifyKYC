-- Idempotent re-application of the isActive column added in
-- 20260622143450_add_user_is_active. That migration's deploy-phase run on
-- production did not result in the column actually existing (confirmed via
-- a live Prisma P2022 "column does not exist" error on /auth/login), while
-- local dev has had it since that migration ran. IF NOT EXISTS makes this a
-- safe no-op wherever the column is already present.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT true;
