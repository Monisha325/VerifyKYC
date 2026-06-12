-- Migration: restrict audit_events table to INSERT + SELECT only
-- Implements claw.md rule #8: audit log is APPEND-ONLY.
--
-- IMPORTANT: This migration creates a dedicated DB role for the application
-- server and revokes UPDATE + DELETE on audit_events.  It must be run by a
-- superuser (or the owner of the table) — not by the application role itself.
--
-- Steps:
--   1. Create the verikyc_app role (idempotent).
--   2. Grant it the minimum privileges needed to run the app.
--   3. Explicitly REVOKE UPDATE and DELETE from audit_events on every role.
--
-- After running this migration, set DATABASE_URL in core/.env to use
-- verikyc_app@neon instead of the owner role.

-- 1. Create the restricted application role (safe to re-run)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'verikyc_app') THEN
    CREATE ROLE verikyc_app LOGIN PASSWORD 'REPLACE_WITH_STRONG_PASSWORD';
  END IF;
END
$$;

-- 2. Grant normal DML on all application tables
GRANT USAGE ON SCHEMA public TO verikyc_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO verikyc_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO verikyc_app;

-- 3. Revoke UPDATE and DELETE on audit_events — append-only enforcement
REVOKE UPDATE, DELETE ON TABLE audit_events FROM verikyc_app;
-- Also block the table owner from accident (belt + suspenders)
-- NOTE: The owner can always grant themselves back; this is a process guardrail.
REVOKE UPDATE, DELETE ON TABLE audit_events FROM PUBLIC;

-- Verify (run manually to confirm):
-- SELECT grantee, privilege_type FROM information_schema.role_table_grants
-- WHERE table_name = 'audit_events' ORDER BY grantee, privilege_type;
