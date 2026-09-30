import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getOrCreateInstallId,
  installIdPath,
  resetInstallIdStateForTests,
} from "../../../src/providers/integrations/install-id";
import { getGrokInstallId } from "../../../src/providers/integrations/grok/grok-install-id";
import { getCodexInstallId } from "../../../src/providers/integrations/codex/codex-identity";

let directory: string | undefined;
let previousCwd: string | undefined;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  resetInstallIdStateForTests();
  savedEnv["CARTETHYIA_INSTALL_ID_DIR"] = process.env["CARTETHYIA_INSTALL_ID_DIR"];
  savedEnv["HOME"] = process.env["HOME"];
  savedEnv["USERPROFILE"] = process.env["USERPROFILE"];
});

afterEach(async () => {
  if (previousCwd !== undefined) {
    process.chdir(previousCwd);
    previousCwd = undefined;
  }
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function tempDirectory(): Promise<string> {
  directory = await mkdtemp(join(tmpdir(), "cartethyia-install-id-"));
  return directory;
}

/** Moves the process into a scratch directory so `./data` resolves there. */
async function useWorkingDirectory(): Promise<string> {
  previousCwd = process.cwd();
  const cwd = await tempDirectory();
  process.chdir(cwd);
  return cwd;
}

describe("install-id persistence", () => {
  test("creates the id once and reuses it", async () => {
    const path = join(await tempDirectory(), "nested", "grok-install-id");
    const first = await getOrCreateInstallId("grok", path);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(await getOrCreateInstallId("grok", path)).toBe(first);
    expect((await readFile(path, "utf8")).trim()).toBe(first);
  });

  test("adopts an id another writer created instead of minting a second", async () => {
    const path = join(await tempDirectory(), "codex-install-id");
    await writeFile(path, "existing-id\n", "utf8");
    expect(await getOrCreateInstallId("codex", path)).toBe("existing-id");
  });

  test("honours the configured directory", async () => {
    const root = await tempDirectory();
    process.env["CARTETHYIA_INSTALL_ID_DIR"] = join(root, "custom");
    expect(installIdPath("grok")).toBe(join(root, "custom", "grok-install-id"));
    const id = await getGrokInstallId();
    expect((await readFile(installIdPath("grok"), "utf8")).trim()).toBe(id);
  });

  test("falls through an unusable HOME to a writable data directory", async () => {
    // The container's shape: HOME is set (to /root) but cannot be written by
    // the runtime user. The next candidate must be tried, not abandoned.
    const cwd = await useWorkingDirectory();
    const homeIsAFile = join(cwd, "home-file");
    await writeFile(homeIsAFile, "not a directory", "utf8");
    delete process.env["CARTETHYIA_INSTALL_ID_DIR"];
    process.env["HOME"] = homeIsAFile;
    delete process.env["USERPROFILE"];

    const id = await getGrokInstallId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const expected = join(cwd, "data", ".cartethyia", "grok-install-id");
    expect(existsSync(expected)).toBe(true);
    expect((await readFile(expected, "utf8")).trim()).toBe(id);
    // Persisted, not memoized: a fresh read must agree.
    expect(await getGrokInstallId()).toBe(id);
  });

  test("every candidate failing yields a stable in-process id, never a throw", async () => {
    // The whole point of the fix: a broken identity file must not take the
    // provider offline. Point every candidate at something impossible.
    const cwd = await useWorkingDirectory();
    const blocked = join(cwd, "blocked");
    await writeFile(blocked, "not a directory", "utf8");
    // `./data` would resolve to a writable scratch dir, so block it with a file.
    await writeFile(join(cwd, "data"), "not a directory", "utf8");
    process.env["CARTETHYIA_INSTALL_ID_DIR"] = blocked;
    process.env["HOME"] = blocked;
    delete process.env["USERPROFILE"];

    const grokId = await getGrokInstallId();
    const codexId = await getCodexInstallId();
    expect(grokId).toMatch(/^[0-9a-f-]{36}$/);
    expect(codexId).toMatch(/^[0-9a-f-]{36}$/);
    // Same process, same answer — a request must not see the identity change.
    expect(await getGrokInstallId()).toBe(grokId);
  });
});
