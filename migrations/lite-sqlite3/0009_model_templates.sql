-- Adds model templates (Lite / SQLite): named model whitelist presets a
-- tenant reuses when provisioning API keys, plus the nullable link from a
-- key to the template it mirrors.
--
-- SQLite accepts a nullable `ADD COLUMN` carrying a `REFERENCES` clause (the
-- restriction is only on non-null defaults), so the foreign key is declared
-- inline exactly as on PostgreSQL, including `ON DELETE SET NULL`: deleting
-- a template detaches its keys rather than deleting them, and the key's
-- copied model list stays in force. `models` is `text` holding JSON, and
-- timestamps are `text` with the baseline's strftime defaults.
CREATE TABLE "model_templates" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL,
  "name" text NOT NULL,
  "models" text NOT NULL,
  "created_at" text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
  "updated_at" text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
  CONSTRAINT "model_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX "model_templates_tenant_name_uidx" ON "model_templates" ("tenant_id", "name");
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "model_template_id" text REFERENCES "model_templates"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX "api_keys_model_template_id_idx" ON "api_keys" ("model_template_id");
