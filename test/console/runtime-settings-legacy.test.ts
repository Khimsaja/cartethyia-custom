/**
 * Runtime settings: how a stored preference bag becomes the response an
 * operator's console reads.
 *
 * The interesting part is not the happy path — it is what happens to a row
 * written by an *older build*. `ponyTailLevel` predates `ponyTailEnabled`:
 * the original bag stored only the level, where `null` meant off and any level
 * meant on. The enable flag was added later, and there is, measured, no
 * migration that backfills it (`grep -rn ponyTail migrations/*.sql` is empty),
 * so a production row written before the flag existed still carries only the
 * level.
 *
 * That makes the legacy branch in `store.ts` a data contract rather than dead
 * code, and this file exists so it is not deleted as such. Deleting it would
 * silently switch the feature off for every operator who enabled it before the
 * flag shipped — a regression no type error and no fresh-database test could
 * catch, because a fresh database has no such rows.
 *
 * The three cases that matter are therefore: a legacy row stays on, a row that
 * explicitly turned it off stays off, and a row with no ponyTail keys at all is
 * off. Each is asserted through the real store against a real database, since
 * the conversion is what the store does, not a helper that could be tested
 * alone.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { getDb } from "../../src/persistence/postgres";
import { consoleSettings } from "../../src/persistence/schema";
import { DrizzleRuntimeSettingsStore } from "../../src/console/settings/store";
import { dbDescribe } from "../helpers/database";
import { createWorld, type GatewayWorld } from "../helpers/fixtures";

dbDescribe("runtime settings: the legacy ponyTail bag", () => {
  let world: GatewayWorld;
  const store = new DrizzleRuntimeSettingsStore(getDb());

  beforeAll(async () => {
    world = await createWorld();
  });

  afterAll(async () => {
    await world?.cleanup();
  });

  /** Writes a raw preferences bag, exactly as an older build would have. */
  async function writeBag(preferences: Record<string, unknown>): Promise<void> {
    await getDb()
      .insert(consoleSettings)
      .values({ tenantId: world.tenantId, preferences, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: consoleSettings.tenantId,
        set: { preferences, updatedAt: new Date() },
      });
  }

  async function read(): Promise<{ ponyTailEnabled: boolean; ponyTailLevel: string }> {
    const settings = await store.get(world.tenantId);
    return { ponyTailEnabled: settings.ponyTailEnabled, ponyTailLevel: settings.ponyTailLevel };
  }

  test("a legacy row with only a level reads as enabled", async () => {
    // The pre-flag shape: a level and no enable flag. `null` meant off, so any
    // level present meant on — and it must stay on.
    await writeBag({ ponyTailLevel: "ultra" });
    const settings = await read();
    expect(settings.ponyTailEnabled).toBe(true);
    expect(settings.ponyTailLevel).toBe("ultra");
  });

  test("every legacy level survives the conversion", async () => {
    for (const level of ["lite", "full", "ultra"] as const) {
      await writeBag({ ponyTailLevel: level });
      expect(await read()).toEqual({ ponyTailEnabled: true, ponyTailLevel: level });
    }
  });

  test("an explicit off wins over a stored level", async () => {
    // The current shape: the flag is authoritative. An operator who turned it
    // off must not be switched back on by a level that is still in the bag —
    // the console keeps the level so the intensity survives a re-enable.
    await writeBag({ ponyTailEnabled: false, ponyTailLevel: "ultra" });
    expect(await read()).toEqual({ ponyTailEnabled: false, ponyTailLevel: "ultra" });
  });

  test("an explicit on with no level falls back to the default intensity", async () => {
    await writeBag({ ponyTailEnabled: true });
    expect(await read()).toEqual({ ponyTailEnabled: true, ponyTailLevel: "full" });
  });

  test("a bag with no ponyTail keys at all is off", async () => {
    await writeBag({});
    expect(await read()).toEqual({ ponyTailEnabled: false, ponyTailLevel: "full" });
  });

  test("an invalid legacy level does not enable the feature", async () => {
    // `storedPonyTailLevel` returns null for anything outside the vocabulary,
    // so a corrupt or future value reads as "no legacy level" rather than as
    // consent — the feature stays off, which is the fail-closed direction.
    await writeBag({ ponyTailLevel: "extreme" });
    expect(await read()).toEqual({ ponyTailEnabled: false, ponyTailLevel: "full" });
  });

  test("a null legacy level is off, matching the pre-flag meaning", async () => {
    await writeBag({ ponyTailLevel: null });
    expect(await read()).toEqual({ ponyTailEnabled: false, ponyTailLevel: "full" });
  });
});
