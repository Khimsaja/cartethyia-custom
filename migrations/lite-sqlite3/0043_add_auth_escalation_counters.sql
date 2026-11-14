-- Adds auth-escalation streak columns (2026-11-04, user-approved policy) —
-- see the identically named PostgreSQL migration for why. Both backends
-- must apply the same behavior; SQLite stores timestamps as text (ISO).
--
-- Idempotency comes from the migration ledger, not from the statement: the
-- runner records the file inside the same transaction, so a file that has
-- already run is never re-executed.
--
-- NOTE: the runner already wraps each migration in a transaction, so this file
-- must NOT issue BEGIN/COMMIT.
ALTER TABLE "provider_accounts" ADD COLUMN "consecutive_auth_rejections" integer NOT NULL DEFAULT 0;
ALTER TABLE "provider_accounts" ADD COLUMN "last_auth_rejection_at" text;
ALTER TABLE "network_pools" ADD COLUMN "consecutive_auth_rejections" integer NOT NULL DEFAULT 0;
ALTER TABLE "network_pools" ADD COLUMN "last_auth_rejection_at" text;
ALTER TABLE "provider_pool_accounts" ADD COLUMN "consecutive_auth_rejections" integer NOT NULL DEFAULT 0;
ALTER TABLE "provider_pool_accounts" ADD COLUMN "last_auth_rejection_at" text;
