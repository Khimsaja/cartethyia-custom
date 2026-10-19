-- Restores the model_templates table + api_keys.model_template_id link.
--
-- Upstream 2.4.x removed the model-template system; TipRouter's key
-- provisioning (template sweep, buyer key sync) depends on it, so this
-- migration brings the table back. Idempotent: safe to apply on databases
-- that already carry the table from an older baseline.
CREATE TABLE IF NOT EXISTS "model_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants" ("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "models" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "model_templates_tenant_name_uidx" ON "model_templates" USING btree ("tenant_id", "name");
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "model_template_id" uuid REFERENCES "model_templates" ("id") ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS "api_keys_model_template_id_idx" ON "api_keys" USING btree ("model_template_id");
