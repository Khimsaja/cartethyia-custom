-- Restores api_keys.expires_at (hard expiry for time-boxed keys).
--
-- Upstream 2.4.x dropped the column from the Drizzle schema; TipRouter's
-- key extension flow (extendByDays) writes it. Idempotent.
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "expires_at" timestamptz;
