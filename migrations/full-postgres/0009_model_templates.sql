-- Adds model templates: named model whitelist presets a tenant reuses when
-- provisioning API keys, plus the nullable link from a key to the template
-- it mirrors. Deleting a template detaches its keys (`ON DELETE SET NULL`)
-- rather than deleting them — the key's copied model list stays in force.
CREATE TABLE "model_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "name" text NOT NULL,
  "models" jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "model_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX "model_templates_tenant_name_uidx" ON "model_templates" ("tenant_id", "name");
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "model_template_id" uuid REFERENCES "model_templates"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX "api_keys_model_template_id_idx" ON "api_keys" ("model_template_id");
