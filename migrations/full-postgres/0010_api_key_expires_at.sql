-- Time-boxed API keys: an optional hard expiry for keys sold or issued with a
-- fixed validity window (e.g. a 30-day subscription key). NULL means the key
-- never expires on its own and lives until revoked, exactly as before.
--
-- Enforcement lives on the gateway auth path: the active-key lookups treat an
-- expired key like a revoked one, and a child (shared) key whose parent
-- template has expired is rejected too, so expiring a template cuts off every
-- recipient it issued.
ALTER TABLE "api_keys"
  ADD COLUMN IF NOT EXISTS "expires_at" timestamptz;
