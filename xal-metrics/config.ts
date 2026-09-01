/*
 * Plugin configuration (#35). XAL passes the plugin's own config object as
 * ctx.config (config.json -> pluginConfig.metrics). Defaults keep the plugin
 * fully working with no configuration at all.
 */

export interface MetricsConfig {
  enabled: boolean;
  persistence: boolean;
  stallThresholdMs: number;
  /** Read xal-context-gc session stats and report per-turn deltas. */
  contextGcIntegration: boolean;
}

export const DEFAULT_STALL_THRESHOLD_MS = 1_000;

export function parseMetricsConfig(
  raw: Record<string, unknown> | undefined,
): MetricsConfig {
  const value = raw ?? {};
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : true,
    persistence:
      typeof value.persistence === "boolean" ? value.persistence : true,
    stallThresholdMs:
      typeof value.stallThresholdMs === "number" && value.stallThresholdMs > 0
        ? value.stallThresholdMs
        : DEFAULT_STALL_THRESHOLD_MS,
    contextGcIntegration:
      typeof value.contextGcIntegration === "boolean"
        ? value.contextGcIntegration
        : true,
  };
}
