-- Exclusive provider assignment for proxy pools. A pool with
-- `dedicated_provider_id` set serves ONLY that provider, and that provider
-- stops using shared pools (see `resolveNetworkPools` in
-- `src/transport/routing/route-catalog.ts`). NULL keeps the existing
-- meaning — a shared pool, available to every provider without an
-- exclusive assignment — so every existing row keeps exactly its current
-- routing. The reference clears itself when the provider row is deleted,
-- so a removed provider never strands pools.
ALTER TABLE "network_pools"
  ADD COLUMN "dedicated_provider_id" text REFERENCES "providers"("id") ON DELETE SET NULL;
CREATE INDEX "network_pools_dedicated_provider_id_idx" ON "network_pools" ("dedicated_provider_id");
