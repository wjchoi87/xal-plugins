/*
 * Plugin configuration (#23 in INSTRUCTION.md).
 *
 * XAL passes the plugin's own config object as ctx.config
 * (config.json -> pluginConfig["context-gc"]). Defaults keep the plugin
 * fully working with no configuration at all.
 *
 * Mode semantics:
 * - conservative (default): published thresholds, highest fidelity; any
 *   uncertain classification stays KEEP_RAW.
 * - balanced: same deterministic rules on lower paging thresholds.
 * - aggressive: reserved for future use; today it only lowers thresholds
 *   further. Semantic pruning is deliberately never enabled by mode (#23).
 */

export type ContextGcMode = "conservative" | "balanced" | "aggressive";

export interface ContextGcConfig {
  enabled: boolean;
  mode: ContextGcMode;

  genericPageThresholdBytes: number;
  searchPageThresholdBytes: number;
  filePageThresholdBytes: number;
  commandPageThresholdBytes: number;

  previewBytes: number;

  recallDefaultBytes: number;
  recallMaxBytes: number;

  exactDedup: boolean;
  stripAnsi: boolean;

  persistence: boolean;
  maxStorageMb: number;

  debug: boolean;
}

export const DEFAULT_CONFIG: ContextGcConfig = {
  enabled: true,
  mode: "conservative",

  genericPageThresholdBytes: 24_576,
  searchPageThresholdBytes: 12_288,
  filePageThresholdBytes: 24_576,
  commandPageThresholdBytes: 16_384,

  previewBytes: 4_096,

  recallDefaultBytes: 12_288,
  recallMaxBytes: 32_768,

  exactDedup: true,
  stripAnsi: true,

  persistence: true,
  maxStorageMb: 2_048,

  debug: false,
};

/** Effective thresholds per mode; balanced/aggressive only scale bytes. */
const MODE_THRESHOLD_SCALE: Record<ContextGcMode, number> = {
  conservative: 1,
  balanced: 0.5,
  aggressive: 0.25,
};

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asPositiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function asMode(value: unknown): ContextGcMode {
  if (value === "balanced" || value === "aggressive") return value;
  return "conservative";
}

export interface ResolvedContextGcConfig {
  config: ContextGcConfig;
  /** Effective per-class paging thresholds after mode scaling. */
  thresholds: {
    generic: number;
    search: number;
    file: number;
    command: number;
  };
}

export function parseContextGcConfig(
  raw: Record<string, unknown> | undefined,
): ResolvedContextGcConfig {
  const value = raw ?? {};
  const mode = asMode(value.mode);
  const scale = MODE_THRESHOLD_SCALE[mode];
  const base: ContextGcConfig = {
    ...DEFAULT_CONFIG,
    mode,
    enabled: asBoolean(value.enabled, DEFAULT_CONFIG.enabled),
    genericPageThresholdBytes: asPositiveNumber(
      value.genericPageThresholdBytes,
      DEFAULT_CONFIG.genericPageThresholdBytes,
    ),
    searchPageThresholdBytes: asPositiveNumber(
      value.searchPageThresholdBytes,
      DEFAULT_CONFIG.searchPageThresholdBytes,
    ),
    filePageThresholdBytes: asPositiveNumber(
      value.filePageThresholdBytes,
      DEFAULT_CONFIG.filePageThresholdBytes,
    ),
    commandPageThresholdBytes: asPositiveNumber(
      value.commandPageThresholdBytes,
      DEFAULT_CONFIG.commandPageThresholdBytes,
    ),
    previewBytes: asPositiveNumber(
      value.previewBytes,
      DEFAULT_CONFIG.previewBytes,
    ),
    recallDefaultBytes: asPositiveNumber(
      value.recallDefaultBytes,
      DEFAULT_CONFIG.recallDefaultBytes,
    ),
    recallMaxBytes: asPositiveNumber(
      value.recallMaxBytes,
      DEFAULT_CONFIG.recallMaxBytes,
    ),
    exactDedup: asBoolean(value.exactDedup, DEFAULT_CONFIG.exactDedup),
    stripAnsi: asBoolean(value.stripAnsi, DEFAULT_CONFIG.stripAnsi),
    persistence: asBoolean(value.persistence, DEFAULT_CONFIG.persistence),
    maxStorageMb: asPositiveNumber(
      value.maxStorageMb,
      DEFAULT_CONFIG.maxStorageMb,
    ),
    debug: asBoolean(value.debug, DEFAULT_CONFIG.debug),
  };
  const recallMax = Math.min(
    base.recallMaxBytes,
    Math.max(base.recallDefaultBytes, DEFAULT_CONFIG.recallMaxBytes),
  );
  return {
    config: { ...base, recallMaxBytes: recallMax },
    thresholds: {
      generic: Math.round(base.genericPageThresholdBytes * scale),
      search: Math.round(base.searchPageThresholdBytes * scale),
      file: Math.round(base.filePageThresholdBytes * scale),
      command: Math.round(base.commandPageThresholdBytes * scale),
    },
  };
}
