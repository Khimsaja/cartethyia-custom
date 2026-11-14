// Route catalog row reads: the fourteen-row-set fan-out that loads the
// persisted catalog once per snapshot. Every query is a column projection (see
// `route-catalog-helpers.ts`) so the payload stays at what the snapshot
// actually reads. The pure build over these rows lives in
// `route-catalog-repository.ts`.

import { asc, eq, ne } from "drizzle-orm";
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import {
  cliToolMappings,
  cliToolSettings,
  consoleSettings,
  modelAliases,
  modelCombos,
  models,
  modelTemplates,
  networkPools,
  poolRoutingSettings,
  providerAccounts,
  providerPoolAccounts,
  providerRoutingSettings,
  providers,
  tenantDisabledModels,
} from "../../persistence/schema";
import type { ConsoleSettingsPreferences } from "../../persistence/schema";
import {
  ACCOUNT_COLUMNS,
  ALIAS_COLUMNS,
  CLI_MAPPING_COLUMNS,
  CLI_MAPPING_SETTING_COLUMNS,
  COMBO_COLUMNS,
  DISABLED_MODEL_COLUMNS,
  MODEL_COLUMNS,
  type ModelRouteRow,
  POOL_ACCOUNT_COLUMNS,
  POOL_COLUMNS,
  POOL_SETTING_COLUMNS,
  PROVIDER_COLUMNS,
  ROUTING_COLUMNS,
  TEMPLATE_COLUMNS,
} from "./route-catalog-helpers";

/**
 * Runs async tasks with at most `limit` in flight, preserving result order.
 * Exported so the concurrency bound is unit-testable without a database.
 * The mapped-tuple signature keeps `Promise.all`-style destructuring typed:
 * each task's result type rides with its position instead of collapsing
 * into a union.
 */
export async function runBounded<T extends readonly unknown[]>(
  tasks: { [K in keyof T]: () => Promise<T[K]> },
  limit: number,
): Promise<T> {
  const results: unknown[] = new Array(tasks.length);
  const runTask = tasks as unknown as readonly (() => Promise<unknown>)[];
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < runTask.length) {
      const index = next;
      next += 1;
      results[index] = await runTask[index]!();
    }
  });
  await Promise.all(workers);
  return results as unknown as T;
}

/**
 * Concurrent reads a snapshot rebuild may hold at once. The rebuild shares
 * one Postgres pool (`DATABASE_POOL_MAX`) with the request path, and its
 * fourteen catalog reads used to start together — fourteen connections
 * claimed in the same instant a burst of key lookups needed them, which is
 * one of the ways a rebuild turned into connect timeouts for everyone
 * (2026-11-14). Four lanes still finish the reads quickly — each is a
 * single indexed select — without spiking the pool.
 */
const SNAPSHOT_READ_CONCURRENCY = 4;

/** A row of `providers` as the snapshot read sees it. */
type ProviderRouteRow = { [K in keyof typeof PROVIDER_COLUMNS]: (typeof providers.$inferSelect)[K] };
/** A row of `provider_accounts` as the snapshot read sees it. */
export type AccountRouteRow = { [K in keyof typeof ACCOUNT_COLUMNS]: (typeof providerAccounts.$inferSelect)[K] };
/** A row of `model_aliases` as the snapshot read sees it. */
type AliasRouteRow = { [K in keyof typeof ALIAS_COLUMNS]: (typeof modelAliases.$inferSelect)[K] };
/** A row of `model_combos` as the snapshot read sees it. */
type ComboRouteRow = { [K in keyof typeof COMBO_COLUMNS]: (typeof modelCombos.$inferSelect)[K] };
/** A row of `model_templates` as the snapshot read sees it. */
type TemplateRouteRow = { [K in keyof typeof TEMPLATE_COLUMNS]: (typeof modelTemplates.$inferSelect)[K] };
/** A row of `provider_routing_settings` as the snapshot read sees it. */
type RoutingRouteRow = { [K in keyof typeof ROUTING_COLUMNS]: (typeof providerRoutingSettings.$inferSelect)[K] };
/** A row of `network_pools` as the snapshot read sees it. */
type PoolRouteRow = { [K in keyof typeof POOL_COLUMNS]: (typeof networkPools.$inferSelect)[K] };
/** A row of `provider_pool_accounts` as the snapshot read sees it. */
export type PoolAccountRouteRow = {
  [K in keyof typeof POOL_ACCOUNT_COLUMNS]: (typeof providerPoolAccounts.$inferSelect)[K]
};
/** A row of `tenant_disabled_models` as the snapshot read sees it. */
type DisabledModelRouteRow = {
  [K in keyof typeof DISABLED_MODEL_COLUMNS]: (typeof tenantDisabledModels.$inferSelect)[K]
};
/** A row of `cli_tool_mappings` as the snapshot read sees it. */
type CliMappingRouteRow = {
  [K in keyof typeof CLI_MAPPING_COLUMNS]: (typeof cliToolMappings.$inferSelect)[K]
};
/** A row of `cli_tool_settings` as the snapshot read sees it. */
type CliMappingSettingRouteRow = {
  [K in keyof typeof CLI_MAPPING_SETTING_COLUMNS]: (typeof cliToolSettings.$inferSelect)[K]
};
/** A row of `pool_routing_settings` as the snapshot read sees it. */
type PoolSettingRouteRow = {
  [K in keyof typeof POOL_SETTING_COLUMNS]: (typeof poolRoutingSettings.$inferSelect)[K]
};
/** A row of `console_settings` as the snapshot read sees it. */
type SettingsRouteRow = { tenantId: string | null; preferences: ConsoleSettingsPreferences };

/** The fourteen row sets behind one snapshot load. */
export interface CatalogRead {
  providerRows: readonly ProviderRouteRow[];
  modelRows: readonly ModelRouteRow[];
  accountRows: readonly AccountRouteRow[];
  aliasRows: readonly AliasRouteRow[];
  comboRows: readonly ComboRouteRow[];
  templateRows: readonly TemplateRouteRow[];
  routingRows: readonly RoutingRouteRow[];
  poolRows: readonly PoolRouteRow[];
  poolAccountRows: readonly PoolAccountRouteRow[];
  disabledModelRows: readonly DisabledModelRouteRow[];
  cliMappingRows: readonly CliMappingRouteRow[];
  cliMappingSettingRows: readonly CliMappingSettingRouteRow[];
  poolSettingRows: readonly PoolSettingRouteRow[];
  settingsRows: readonly SettingsRouteRow[];
}

/**
 * Reads the persisted route catalog in one fan-out. Every query is a column
 * projection (see `route-catalog-helpers.ts`) so the payload stays at what the
 * snapshot actually reads.
 */
export async function readCatalogRows(db: CartethyiaDatabase): Promise<CatalogRead> {
  const [
    providerRows,
    modelRows,
    accountRows,
    aliasRows,
    comboRows,
    templateRows,
    routingRows,
    poolRows,
    poolAccountRows,
    disabledModelRows,
    cliMappingRows,
    cliMappingSettingRows,
    poolSettingRows,
    settingsRows,
  ] = await runBounded(
    [
      () => db.select(PROVIDER_COLUMNS).from(providers).where(eq(providers.enabled, true)),
      () => db.select(MODEL_COLUMNS).from(models),
      () =>
        db
          .select(ACCOUNT_COLUMNS)
          .from(providerAccounts)
          .where(ne(providerAccounts.status, "disabled"))
          .orderBy(asc(providerAccounts.status), asc(providerAccounts.createdAt), asc(providerAccounts.id)),
      () => db.select(ALIAS_COLUMNS).from(modelAliases),
      () => db.select(COMBO_COLUMNS).from(modelCombos),
      () => db.select(TEMPLATE_COLUMNS).from(modelTemplates),
      () => db.select(ROUTING_COLUMNS).from(providerRoutingSettings),
      () => db.select(POOL_COLUMNS).from(networkPools),
      () => db.select(POOL_ACCOUNT_COLUMNS).from(providerPoolAccounts),
      () => db.select(DISABLED_MODEL_COLUMNS).from(tenantDisabledModels),
      () => db.select(CLI_MAPPING_COLUMNS).from(cliToolMappings),
      () => db.select(CLI_MAPPING_SETTING_COLUMNS).from(cliToolSettings),
      () => db.select(POOL_SETTING_COLUMNS).from(poolRoutingSettings),
      // The cooldown override is a console_settings preference, read inside
      // the same fan-out rather than per request: one more row set on a
      // query that already runs, instead of a Postgres round trip on every
      // admitted request.
      () =>
        db
          .select({ tenantId: consoleSettings.tenantId, preferences: consoleSettings.preferences })
          .from(consoleSettings),
    ],
    SNAPSHOT_READ_CONCURRENCY,
  );
  return {
    providerRows,
    modelRows,
    accountRows,
    aliasRows,
    comboRows,
    templateRows,
    routingRows,
    poolRows,
    poolAccountRows,
    disabledModelRows,
    cliMappingRows,
    cliMappingSettingRows,
    poolSettingRows,
    settingsRows,
  };
}
