-- Adds auth-escalation streak columns (2026-11-04, user-approved policy).
--
-- consecutive_auth_rejections counts consecutive upstream auth rejections
-- within a 24 h window for static-token accounts (reset on any success or
-- non-auth verdict); last_auth_rejection_at bounds the window. These live
-- in the shared healthColumns() in schema.ts, so all three tables that
-- spread it get both columns.
--
-- ADD COLUMN IF NOT EXISTS keeps the file idempotent: a database built from
-- a newer baseline that already carries the columns must not fail startup.
ALTER TABLE "provider_accounts" ADD COLUMN IF NOT EXISTS "consecutive_auth_rejections" integer NOT NULL DEFAULT 0;
ALTER TABLE "provider_accounts" ADD COLUMN IF NOT EXISTS "last_auth_rejection_at" timestamptz;
ALTER TABLE "network_pools" ADD COLUMN IF NOT EXISTS "consecutive_auth_rejections" integer NOT NULL DEFAULT 0;
ALTER TABLE "network_pools" ADD COLUMN IF NOT EXISTS "last_auth_rejection_at" timestamptz;
ALTER TABLE "provider_pool_accounts" ADD COLUMN IF NOT EXISTS "consecutive_auth_rejections" integer NOT NULL DEFAULT 0;
ALTER TABLE "provider_pool_accounts" ADD COLUMN IF NOT EXISTS "last_auth_rejection_at" timestamptz;
