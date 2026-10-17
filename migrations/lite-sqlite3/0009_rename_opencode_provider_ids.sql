-- Rename the three OpenCode provider ids so the free tier is `opencode`
-- rather than `opencodeft`:
--
--   opencodeft  -> opencode
--   opencodezen -> opencode-zen
--   opencodego  -> opencode-go
--
-- Mirrors the PostgreSQL migration. `providers.id` is the primary key every
-- other table references, so the row moves first and each dependent table is
-- updated explicitly — SQLite only follows a foreign key on update when the
-- constraint declares `ON UPDATE CASCADE`, which the baseline does not.
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
