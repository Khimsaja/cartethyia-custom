-- Rename the three OpenCode provider ids so the free tier is `opencode`
-- rather than `opencodeft`:
--
--   opencodeft  -> opencode
--   opencodezen -> opencode-zen
--   opencodego  -> opencode-go
--
-- `providers.id` is the primary key every other table references, so the row
-- must move before its dependents or the foreign keys fail. `ON UPDATE` is not
-- declared on those constraints (they cascade on delete only), which is why
-- each dependent table is updated explicitly here instead of relying on the
-- reference to follow.
--
-- Order matters: `providers` first, then the tables that reference it. The
-- telemetry tables carry the id as a plain column with no constraint, so they
-- are renamed too — otherwise old rows would name a provider that no longer
-- exists and the dashboard would drop them from per-provider figures.
--
-- A database that never had these ids is unaffected: every statement matches
-- zero rows.

UPDATE "providers" SET "id" = 'opencode' WHERE "id" = 'opencodeft';
UPDATE "providers" SET "id" = 'opencode-zen' WHERE "id" = 'opencodezen';
UPDATE "providers" SET "id" = 'opencode-go' WHERE "id" = 'opencodego';

UPDATE "provider_accounts" SET "provider_id" = 'opencode' WHERE "provider_id" = 'opencodeft';
UPDATE "provider_accounts" SET "provider_id" = 'opencode-zen' WHERE "provider_id" = 'opencodezen';
UPDATE "provider_accounts" SET "provider_id" = 'opencode-go' WHERE "provider_id" = 'opencodego';

UPDATE "models" SET "provider_id" = 'opencode' WHERE "provider_id" = 'opencodeft';
UPDATE "models" SET "provider_id" = 'opencode-zen' WHERE "provider_id" = 'opencodezen';
UPDATE "models" SET "provider_id" = 'opencode-go' WHERE "provider_id" = 'opencodego';

UPDATE "tenant_disabled_models" SET "provider_id" = 'opencode' WHERE "provider_id" = 'opencodeft';
UPDATE "tenant_disabled_models" SET "provider_id" = 'opencode-zen' WHERE "provider_id" = 'opencodezen';
UPDATE "tenant_disabled_models" SET "provider_id" = 'opencode-go' WHERE "provider_id" = 'opencodego';

UPDATE "provider_routing_settings" SET "provider_id" = 'opencode' WHERE "provider_id" = 'opencodeft';
UPDATE "provider_routing_settings" SET "provider_id" = 'opencode-zen' WHERE "provider_id" = 'opencodezen';
UPDATE "provider_routing_settings" SET "provider_id" = 'opencode-go' WHERE "provider_id" = 'opencodego';

UPDATE "telemetry_events" SET "provider_id" = 'opencode' WHERE "provider_id" = 'opencodeft';
UPDATE "telemetry_events" SET "provider_id" = 'opencode-zen' WHERE "provider_id" = 'opencodezen';
UPDATE "telemetry_events" SET "provider_id" = 'opencode-go' WHERE "provider_id" = 'opencodego';
