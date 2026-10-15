/** Runs the compiled binary from the repository root. */
import { resolve } from "node:path";
import { compiledBinaryPath } from "../build/binary";

const projectRoot = resolve(import.meta.dir, "..", "..");

/** Runs the compiled binary with inherited stdio; resolves to its exit code. */
export async function startBinary(): Promise<number> {
  const binary = resolve(projectRoot, compiledBinaryPath());
  if (!(await Bun.file(binary).exists())) {
    throw new Error(`${binary} is missing; run bun run build first`);
  }

  process.env.NODE_ENV ??= "production";
  process.env.CARTETHYIA_SERVER_MAX_BODY_BYTES ??= String(8 * 1024 * 1024 * 1024);

  // A compiled binary has a virtual import.meta.dir, so without an explicit
  // root resolvePackagePath() lands on "/" and migrations/dashboard assets
  // are not found. Default it to this repository (deployments such as the
  // Dockerfile set CARTETHYIA_PACKAGE_ROOT themselves and win).
  const packageRoot = process.env.CARTETHYIA_PACKAGE_ROOT?.trim()
    ? process.env.CARTETHYIA_PACKAGE_ROOT
    : projectRoot;
  const child = Bun.spawn([binary], {
    cwd: projectRoot,
    env: { ...process.env, CARTETHYIA_PACKAGE_ROOT: packageRoot },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await child.exited;
}

if (import.meta.main) {
  process.exit(await startBinary());
}
