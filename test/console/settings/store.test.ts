import { describe, expect, test } from "bun:test";
import { resolveRedisMode } from "../../../src/persistence/readiness";
import { DrizzleRuntimeSettingsStore } from "../../../src/console/settings/store";

const REMOVED_RUNTIME_SETTING_KEYS = [
  "tokenSaverProfile",
  "ponytailEnabled",
  "cavemanEnabled",
  "redisModeDesired",
] as const;

describe("DrizzleRuntimeSettingsStore", () => {
  /**
   * Minimal Drizzle stand-in. `insert().values(...)` records what was written so
   * `returning()` can hand back the persisted row, which is what the upsert path
   * maps into the response — an empty `returning()` would make every write
   * assertion below a tautology over the defaults.
   */
  function makeDb() {
    function chain(result: unknown[]) {
      const builder = {
        from() { return builder; },
        where() { return builder; },
        limit() { return builder; },
        values(written?: Record<string, unknown>) { return chain(written ? [written] : result); },
        onConflictDoUpdate() { return builder; },
        returning() { return Promise.resolve(result); },
        async then(resolve: (value: unknown[]) => void) { resolve(result); },
      };
      return builder;
    }
    return {
      select() { return chain([]); },
      insert() { return chain([]); },
    };
  }

  test("returns clean defaults without removed runtime settings", async () => {
    const store = new DrizzleRuntimeSettingsStore(makeDb() as never);
    const result = await store.get("tenant-1");
    expect(result.redisModeActual).toBe(resolveRedisMode());
    for (const key of REMOVED_RUNTIME_SETTING_KEYS) {
      expect(key in result).toBe(false);
    }
  });

  test("defaults payload capture to metadata", async () => {
    const store = new DrizzleRuntimeSettingsStore(makeDb() as never);
    const result = await store.get("tenant-1");
    expect(result.telemetryPayloads).toBe("metadata");
  });

  test("round-trips the metadata capture mode", async () => {
    const store = new DrizzleRuntimeSettingsStore(makeDb() as never);
    const result = await store.update("tenant-1", { telemetryPayloads: "metadata" });
    expect(result.telemetryPayloads).toBe("metadata");
  });

  test("updates active settings through the upsert shape", async () => {
    const store = new DrizzleRuntimeSettingsStore(makeDb() as never);
    const result = await store.update("tenant-1", { telemetryPayloads: "none" });
    expect(result.telemetryPayloads).toBe("none");
    for (const key of REMOVED_RUNTIME_SETTING_KEYS) {
      expect(key in result).toBe(false);
    }
  });

  /** A `select` that returns one stored preferences row, to read the mapper. */
  function dbWithPreferences(preferences: Record<string, unknown>) {
    function chain(result: unknown[]) {
      const builder = {
        from() { return builder; },
        where() { return builder; },
        limit() { return builder; },
        values(written?: Record<string, unknown>) { return chain(written ? [written] : result); },
        onConflictDoUpdate() { return builder; },
        returning() { return Promise.resolve(result); },
        async then(resolve: (value: unknown[]) => void) { resolve(result); },
      };
      return builder;
    }
    const row = { tenantId: "tenant-1", preferences, updatedAt: new Date(0) };
    return { select() { return chain([row]); }, insert() { return chain([row]); } };
  }

  test("reads RTK and PonyTail defaults when the bag is empty", async () => {
    const store = new DrizzleRuntimeSettingsStore(dbWithPreferences({}) as never);
    const result = await store.get("tenant-1");
    expect(result.rtkPruneEnabled).toBe(false);
    expect(result.rtkPruneLevel).toBe("full");
    expect(result.ponyTailEnabled).toBe(false);
    expect(result.ponyTailLevel).toBe("full");
  });

  test("a legacy bag with a stored ponyTailLevel but no enable flag reads as enabled", async () => {
    // Before the enable toggle, `ponyTailLevel` was the switch: a non-null
    // level meant on. Such a bag must keep PonyTail on rather than silently
    // turning it off on upgrade.
    const store = new DrizzleRuntimeSettingsStore(
      dbWithPreferences({ ponyTailLevel: "ultra" }) as never,
    );
    const result = await store.get("tenant-1");
    expect(result.ponyTailEnabled).toBe(true);
    expect(result.ponyTailLevel).toBe("ultra");
  });

  test("an explicit ponyTailEnabled=false overrides a stored legacy level", async () => {
    const store = new DrizzleRuntimeSettingsStore(
      dbWithPreferences({ ponyTailLevel: "ultra", ponyTailEnabled: false }) as never,
    );
    const result = await store.get("tenant-1");
    expect(result.ponyTailEnabled).toBe(false);
    expect(result.ponyTailLevel).toBe("ultra");
  });
});
