import { openCodeClientVersion } from "./client-version";

export const DEFAULT_ZEN_BASE_URL = "https://opencode.ai/zen/v1";
export const DEFAULT_GO_BASE_URL = "https://opencode.ai/zen/go/v1";

/* Free-tier requests must present the official client's user-agent. The
 * gateway expects the client's `opencode/<channel>/<version>/<artifact>`
 * format (verified live: `opencode/1.18.31` alone gets 403 FreeTierError,
 * `opencode/stable/1.19.3/cli-node` passes). Configurable so a changed
 * format or raised minimum is a config edit, not a plugin release.
 *
 * Policy change:
 * - before: the default version was the hardcoded `1.19.3`
 * - after: the version follows the OpenCode CLI installed on this machine
 *   (see client-version.ts) and falls back to `1.19.3`
 * - reason: the gateway answers 426 Upgrade Required below its floor, so a
 *   pinned default breaks every free-model request once the floor moves
 * - scope: the default only; an explicit `clientUserAgent` still wins */
export function defaultClientUserAgent(): string {
  return `opencode/stable/${openCodeClientVersion()}/cli-node`;
}

export const DEFAULT_CLIENT_USER_AGENT = defaultClientUserAgent();

const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_MODEL_METADATA_URL = "https://models.dev/api.json";
const DEFAULT_MODEL_METADATA_TTL_MS = 12 * 60 * 60 * 1000;

export interface OpenCodeFreeConfig {
  /* How long a fetched source catalog is considered fresh. */
  cacheTtlMs: number;
  /* Dump evaluated model diagnostics to warnings instead of hiding them. */
  debugModels: boolean;
  /* Override the upstream catalog base URLs (normally left default). */
  zenBaseUrl: string;
  goBaseUrl: string;
  /* Sync context limits, retirements, and protocols from models.dev. */
  syncModelMetadata: boolean;
  modelMetadataUrl: string;
  modelMetadataTtlMs: number;
  /* User-agent sent to the OpenCode gateway (free-tier client check). */
  clientUserAgent: string;
}

let config: OpenCodeFreeConfig = {
  cacheTtlMs: DEFAULT_CACHE_TTL_MS,
  debugModels: false,
  zenBaseUrl: DEFAULT_ZEN_BASE_URL,
  goBaseUrl: DEFAULT_GO_BASE_URL,
  syncModelMetadata: true,
  modelMetadataUrl: DEFAULT_MODEL_METADATA_URL,
  modelMetadataTtlMs: DEFAULT_MODEL_METADATA_TTL_MS,
  clientUserAgent: DEFAULT_CLIENT_USER_AGENT,
};

function readPositiveMs(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    throw new Error(
      `opencode-free ${key} must be a positive number of milliseconds`,
    );
  return value;
}

/* Config is resolved once at registration time from pluginConfig.opencode-free.
 * Defaults keep the plugin working with no configuration at all. */
export function resolveConfig(raw: Record<string, unknown>): void {
  const next: OpenCodeFreeConfig = { ...config };
  const cfg = raw;
  const cacheRaw = cfg.cacheTtlMs;
  if (cacheRaw !== undefined) {
    next.cacheTtlMs = readPositiveMs(cacheRaw, "cacheTtlMs");
  }
  const syncRaw = cfg.syncModelMetadata;
  if (syncRaw !== undefined && typeof syncRaw !== "boolean")
    throw new Error("opencode-free syncModelMetadata must be a boolean");
  next.syncModelMetadata = syncRaw ?? true;
  const metadataTtlRaw = cfg.modelMetadataTtlMs;
  next.modelMetadataTtlMs =
    metadataTtlRaw === undefined
      ? DEFAULT_MODEL_METADATA_TTL_MS
      : readPositiveMs(metadataTtlRaw, "modelMetadataTtlMs");
  const debugRaw = cfg.debugModels;
  if (debugRaw !== undefined) {
    if (typeof debugRaw !== "boolean")
      throw new Error("opencode-free debugModels must be a boolean");
    next.debugModels = debugRaw;
  }
  for (const [key, factory] of [
    ["zenBaseUrl", () => DEFAULT_ZEN_BASE_URL],
    ["goBaseUrl", () => DEFAULT_GO_BASE_URL],
    ["modelMetadataUrl", () => DEFAULT_MODEL_METADATA_URL],
    ["clientUserAgent", () => defaultClientUserAgent()],
  ] as const) {
    const rawValue = cfg[key];
    if (rawValue !== undefined) {
      if (typeof rawValue !== "string" || !rawValue.trim())
        throw new Error(`opencode-free ${key} must be a non-empty string`);
      next[key] = rawValue.trim();
    } else {
      next[key] = factory();
    }
  }
  config = next;
}

export function pluginConfig(): OpenCodeFreeConfig {
  return config;
}

export function cacheTtlMs(): number {
  return config.cacheTtlMs;
}

export function debugModels(): boolean {
  return config.debugModels;
}

export function zenBaseUrl(): string {
  return config.zenBaseUrl;
}

export function goBaseUrl(): string {
  return config.goBaseUrl;
}

export function syncModelMetadata(): boolean {
  return config.syncModelMetadata;
}

export function modelMetadataUrl(): string {
  return config.modelMetadataUrl;
}

export function modelMetadataTtlMs(): number {
  return config.modelMetadataTtlMs;
}

export function clientUserAgent(): string {
  return config.clientUserAgent;
}
