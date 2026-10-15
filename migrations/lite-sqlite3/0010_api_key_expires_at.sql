-- Time-boxed API keys (Lite / SQLite): see the PostgreSQL migration of the
-- same name. Timestamps are stored as ISO text in this backend.
ALTER TABLE "api_keys"
  ADD COLUMN "expires_at" text;
