export const DEFAULT_ZEN_BASE_URL = "https://opencode.ai/zen/v1";
export const DEFAULT_GO_BASE_URL = "https://opencode.ai/zen/go/v1";

const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;

export interface OpenCodeFreeConfig {
  /* How long a fetched source catalog is considered fresh. */
  cacheTtlMs: number;
  /* Dump evaluated model diagnostics to warnings instead of hiding them. */
  debugModels: boolean;
  /* Override the upstream catalog base URLs (normally left default). */
  zenBaseUrl: string;
  goBaseUrl: string;
}

let config: OpenCodeFreeConfig = {
  cacheTtlMs: DEFAULT_CACHE_TTL_MS,
  debugModels: false,
  zenBaseUrl: DEFAULT_ZEN_BASE_URL,
  goBaseUrl: DEFAULT_GO_BASE_URL,
};

/* Config is resolved once at registration time from pluginConfig.opencode-free.
 * Defaults keep the plugin working with no configuration at all. */
export function resolveConfig(raw: Record<string, unknown>): void {
  const next: OpenCodeFreeConfig = { ...config };
  const cfg = raw;
  const cacheRaw = cfg.cacheTtlMs;
  if (cacheRaw !== undefined) {
    if (
      typeof cacheRaw !== "number" ||
      !Number.isFinite(cacheRaw) ||
      cacheRaw <= 0
    )
      throw new Error(
        "opencode-free cacheTtlMs must be a positive number of milliseconds",
      );
    next.cacheTtlMs = cacheRaw;
  }
  const debugRaw = cfg.debugModels;
  if (debugRaw !== undefined) {
    if (typeof debugRaw !== "boolean")
      throw new Error("opencode-free debugModels must be a boolean");
    next.debugModels = debugRaw;
  }
  for (const [key, factory] of [
    ["zenBaseUrl", () => DEFAULT_ZEN_BASE_URL],
    ["goBaseUrl", () => DEFAULT_GO_BASE_URL],
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
