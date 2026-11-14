-- Restores api_keys.expires_at. Mirrors
-- migrations/full-postgres/0016_add_api_keys_expires_at.sql.
ALTER TABLE "api_keys" ADD COLUMN "expires_at" text;
