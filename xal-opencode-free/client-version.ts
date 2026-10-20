import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

/* The gateway parses the client version out of the user-agent and answers
 * 426 Upgrade Required when it is below its floor, so the default user-agent
 * has to track a version the gateway still accepts.
 *
 * Policy change:
 * - before: the default user-agent pinned `opencode/stable/1.19.3/cli-node`, so
 *   it went stale as soon as OpenCode raised the floor or the local CLI moved on
 * - after: the default version comes from `opencode --version` (PATH first,
 *   then `~/.opencode/bin/opencode`), cached for the process; a detection below
 *   the verified minimum is raised to it, and `XAL_OPENCODE_CLIENT_VERSION`
 *   overrides both
 * - reason: a raised floor answers 426 Upgrade Required and breaks every
 *   free-model request, which used to need a plugin release
 * - scope: only the default `clientUserAgent`; an explicit `clientUserAgent`
 *   config value always wins */
const VERIFIED_MINIMUM = "1.19.3";
const VERSION_PATTERN = /v?(\d+\.\d+\.\d+)/;
const PROBE_TIMEOUT_MS = 1_500;

let cached: string | undefined;

/** Extract the first semver-looking value from `opencode --version` output. */
export function parseOpenCodeVersion(output: string): string | undefined {
  return VERSION_PATTERN.exec(output)?.[1];
}

function compare(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function detectInstalledVersion(): string | undefined {
  const candidates = [
    "opencode",
    join(homedir(), ".opencode", "bin", "opencode"),
  ];
  for (const binary of candidates) {
    try {
      const output = execFileSync(binary, ["--version"], {
        encoding: "utf8",
        timeout: PROBE_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const version = parseOpenCodeVersion(output);
      if (version) return version;
    } catch {
      // Not installed at this path; try the next candidate.
    }
  }
  return undefined;
}

/** Client version advertised in the default user-agent. Cached per process. */
export function openCodeClientVersion(): string {
  cached ??= resolveVersion();
  return cached;
}

function resolveVersion(): string {
  const override = process.env.XAL_OPENCODE_CLIENT_VERSION?.trim();
  if (override !== undefined && parseOpenCodeVersion(override) === override)
    return override;

  const detected = detectInstalledVersion();
  if (detected !== undefined && compare(detected, VERIFIED_MINIMUM) >= 0)
    return detected;
  return VERIFIED_MINIMUM;
}

/** Test hook: forget the cached version so the next call re-resolves it. */
export function resetOpenCodeClientVersion(): void {
  cached = undefined;
}
