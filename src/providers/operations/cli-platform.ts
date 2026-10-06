/**
 * The client platform this gateway presents to upstreams.
 *
 * A gateway is not the machine the CLI runs on: it forwards on behalf of a
 * client, and whichever OS it happens to be deployed on says nothing about
 * who is calling. Stamping the host's real platform would make every upstream
 * see a Linux datacenter box, which is both wrong about the caller and a
 * fingerprint no real CLI traffic looks like.
 *
 * So the platform is *declared*, not detected — and it is declared once here
 * so every provider stamps the same one. Two adapters claiming different
 * operating systems on the same connection is the inconsistency worth
 * avoiding; the choice of which OS to claim is a configuration decision.
 *
 * Default is macOS: the reference CLIs' own user agents are dominated by it,
 * and it is what the observed Codex and Grok clients report.
 */

/** Platform profiles this gateway can present. */
export type CliPlatformName = "macos" | "linux" | "windows";

/** Overrides the presented platform. Accepted values are the profile names. */
export const CLI_PLATFORM_ENV = "CARTETHYIA_CLI_PLATFORM" as const;

/**
 * macOS release reported in a Codex user agent.
 *
 * `os_info` — the crate Codex reads this from — returns the marketing name
 * (`Mac OS`) followed by the kernel-level version, so the two are kept apart
 * here rather than being fused into one string.
 */
export const MACOS_UA_NAME = "Mac OS" as const;
export const MACOS_UA_VERSION = "27.0.1" as const;

/**
 * Terminal token appended to a Codex user agent.
 *
 * Codex reads the real terminal off the environment (`TERM_PROGRAM` and
 * friends); a gateway has no terminal, so it declares the one the observed
 * macOS clients report.
 */
export const MACOS_TERMINAL_TOKEN = "Apple_Terminal/455" as const;

/** Grok's own platform vocabulary — lowercase, and `aarch64` not `arm64`. */
const GROK_OS: Record<CliPlatformName, string> = {
  macos: "macos",
  linux: "linux",
  windows: "windows",
};

/** Architecture Grok reports for each profile. */
const GROK_ARCH: Record<CliPlatformName, string> = {
  macos: "aarch64",
  linux: "x86_64",
  windows: "x86_64",
};

/**
 * The platform a Codex user agent names, as `os_info` would render it.
 * `Mac OS 27.0.1` on macOS, and the same shape elsewhere.
 */
const CODEX_OS: Record<CliPlatformName, { readonly name: string; readonly version: string }> = {
  macos: { name: MACOS_UA_NAME, version: MACOS_UA_VERSION },
  linux: { name: "Linux", version: "6.8.0" },
  windows: { name: "Windows", version: "10.0.22631" },
};

/** Architecture a Codex user agent names. */
const CODEX_ARCH: Record<CliPlatformName, string> = {
  macos: "arm64",
  linux: "x86_64",
  windows: "x86_64",
};

/**
 * Resolves the configured platform, falling back to macOS.
 *
 * An unrecognized value falls back rather than throwing: a typo in an
 * environment variable should not take every upstream request down.
 */
export function cliPlatform(): CliPlatformName {
  const configured = process.env[CLI_PLATFORM_ENV]?.trim().toLowerCase();
  if (configured === "macos" || configured === "linux" || configured === "windows") {
    return configured;
  }
  return "macos";
}

/**
 * Builds a Codex CLI user agent: `codex_cli_rs/0.160.0 (Mac OS 27.0.1; arm64)
 * Apple_Terminal/455`.
 *
 * Mirrors `get_codex_user_agent` in Codex's own `login` crate — same field
 * order, same separators — so the value is indistinguishable from the real
 * client's.
 */
export function buildCodexUserAgent(version: string, platform = cliPlatform()): string {
  const os = CODEX_OS[platform];
  return `codex_cli_rs/${version} (${os.name} ${os.version}; ${CODEX_ARCH[platform]}) ${MACOS_TERMINAL_TOKEN}`;
}

/**
 * Builds a Grok shell user agent: `grok-shell/0.2.93 (macos; aarch64)`.
 *
 * Mirrors `UserAgent::render` in `xai-grok-http` for the case where the
 * origin client and the agent are the same product.
 */
export function buildGrokShellUserAgent(version: string, platform = cliPlatform()): string {
  return `grok-shell/${version} (${GROK_OS[platform]}; ${GROK_ARCH[platform]})`;
}

/**
 * Builds the Grok auth user agent: `grok-pager/0.2.93 grok-shell/0.2.93
 * (macos; aarch64)`.
 *
 * The pager prefix is what the token and billing endpoints see; it renders
 * the origin product ahead of the agent product, per the same renderer.
 */
export function buildGrokAuthUserAgent(version: string, platform = cliPlatform()): string {
  const suffix = buildGrokShellUserAgent(version, platform);
  return `grok-pager/${version} ${suffix}`;
}

/**
 * Anthropic Stainless OS value — the vocabulary `X-Stainless-OS` uses.
 * `MacOS` here, not `Mac OS`: Stainless spells it without the space.
 */
const STAINLESS_OS: Record<CliPlatformName, string> = {
  macos: "MacOS",
  linux: "Linux",
  windows: "Windows",
};

/** Anthropic Stainless architecture value (`X-Stainless-Arch`). */
const STAINLESS_ARCH: Record<CliPlatformName, string> = {
  macos: "arm64",
  linux: "x64",
  windows: "x64",
};

/**
 * Kimi's `X-Msh-Device-Model`: a "<OS> <release> <arch>" triple built from
 * whatever the host reports. Real Kimi CLI traffic on a Mac reads
 * `macOS <darwin version> arm64`, so the release is rendered per platform
 * rather than read off the host.
 */
const KIMI_DEVICE_MODEL: Record<CliPlatformName, { readonly os: string; readonly release: string; readonly arch: string }> = {
  macos: { os: "macOS", release: "24.6.0", arch: "arm64" },
  linux: { os: "Linux", release: "6.8.0", arch: "x64" },
  windows: { os: "Windows", release: "10.0.22631", arch: "x64" },
};

/** Kimi's `X-Msh-Os-Version`: the human-facing OS version string. */
const KIMI_OS_VERSION: Record<CliPlatformName, string> = {
  macos: "macOS 15.6",
  linux: "Linux 6.8.0",
  windows: "Windows 10.0.22631",
};

/**
 * Kimi's `X-Msh-Device-Name`, i.e. the hostname.
 *
 * Spoofed along with everything else: a gateway's hostname is assigned by the
 * VPS provider and routinely reads `vps-a1b2c3` or `srv-04`, which identifies
 * the deployment far more sharply than an OS string does. Per-account
 * distinction is `X-Msh-Device-Id`'s job, not the hostname's.
 */
const KIMI_DEVICE_NAME: Record<CliPlatformName, string> = {
  macos: "MacBook-Pro.local",
  linux: "localhost",
  windows: "DESKTOP-9QF2KA1",
};

/** Qoder's `cosy-machineos`: "<arch>_<os>". */
const QODER_MACHINE_OS: Record<CliPlatformName, string> = {
  macos: "aarch64_macos",
  linux: "x86_64_linux",
  windows: "x86_64_windows",
};

/** The Anthropic Stainless OS value for the presented platform. */
export function stainlessOs(platform: CliPlatformName = cliPlatform()): string {
  return STAINLESS_OS[platform];
}

/** The Anthropic Stainless architecture value for the presented platform. */
export function stainlessArch(platform: CliPlatformName = cliPlatform()): string {
  return STAINLESS_ARCH[platform];
}

/** Kimi's device-model triple for the presented platform. */
export function kimiDeviceModel(platform: CliPlatformName = cliPlatform()): string {
  const model = KIMI_DEVICE_MODEL[platform];
  return [model.os, model.release, model.arch].join(" ");
}

/** Kimi's OS-version string for the presented platform. */
export function kimiOsVersion(platform: CliPlatformName = cliPlatform()): string {
  return KIMI_OS_VERSION[platform];
}

/** Kimi's device name (hostname) for the presented platform. */
export function kimiDeviceName(platform: CliPlatformName = cliPlatform()): string {
  return KIMI_DEVICE_NAME[platform];
}

/** Qoder's machineos value for the presented platform. */
export function qoderMachineOs(platform: CliPlatformName = cliPlatform()): string {
  return QODER_MACHINE_OS[platform];
}
