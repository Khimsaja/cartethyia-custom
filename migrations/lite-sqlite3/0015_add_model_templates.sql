-- Restores the model_templates table + api_keys.model_template_id link.
-- Mirrors migrations/full-postgres/0015_add_model_templates.sql; SQLite
-- spells the same DDL because the schema is shared. `gen_random_uuid()` is
-- PostgreSQL-only; SQLite rows get their ids from the application default.
CREATE TABLE IF NOT EXISTS "model_templates" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL REFERENCES "tenants" ("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "models" text NOT NULL,
  "created_at" text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "updated_at" text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "model_templates_tenant_name_uidx" ON "model_templates" ("tenant_id", "name");
-- SQLite cannot ADD COLUMN ... REFERENCES in one step on all versions; the
-- column itself is what the application reads.
ALTER TABLE "api_keys" ADD COLUMN "model_template_id" text REFERENCES "model_templates" ("id") ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS "api_keys_model_template_id_idx" ON "api_keys" ("model_template_id");
