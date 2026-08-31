import { isRecord } from "./types";

/* Context window resolution for models discovered from `/models`.
 *
 * The OpenAI-compatible `/models` response carries only model IDs; the Alibaba
 * endpoint exposes no context-length field, so Xal's compaction and context
 * budget would have no anchor. This module supplies the missing numbers from a
 * bundled table verified against the Alibaba Cloud Model Studio docs
 * (international / ap-southeast-1 catalog, snapshot 2026-08), plus per-model
 * config overrides for other regions or custom deployments.
 *
 * Policy change:
 * - before: ModelInfo.contextWindow was never populated (compaction disabled)
 * - after: known models get a context window plus a `contextWindows` ladder
 *   (budget -> maximum) when the maximum exceeds the default budget; config
 *   keys `modelContextWindows` (exact ID -> tokens) and `defaultContextWindow`
 *   (fallback for unknown IDs) can override or fill the maximum
 * - reason: the endpoint does not report context windows, yet Xal needs them
 *   for correct compaction, `/context-window`, and `/compaction-limit`
 * - scope: every model returned to Xal; values are best-effort upstream specs
 *   and always overridable via `modelContextWindows` */

const K = 1024;
const M = 1_000_000;

/* Exact-ID entries take precedence over prefixes. Used where a model's value
 * differs from its family's catch-all or where the ID must not spread to
 * siblings. */
const EXACT_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  /* Third-party, context differs per snapshot/sibling. */
  "Moonshot-Kimi-K2-Instruct": 128 * K,
  "MiniMax-M2.1": 200 * K,
  "MiniMax-M2.5": 192 * K,
  "MiniMax-M2.7": 200 * K,
  "MiniMax-M3": 192 * K,
  "mimo-v2.5-pro": M,
};

/* Prefix rules match the model ID, longest prefix first, so snapshot IDs such
 * as `qwen-plus-2025-04-28` inherit their family's window. Values follow the
 * international (ap-southeast-1) Model Studio catalog; China (cn-beijing)
 * differs for some models (see README) and is covered by `modelContextWindows`
 * overrides. */
const PREFIX_CONTEXT_WINDOWS: ReadonlyArray<readonly [string, number]> = [
  /* Qwen3.8 / Qwen3.7 / Qwen3.6 / Qwen3.5 (current & legacy recommended). */
  ["qwen3.8-max", M],
  ["qwen3.8-flash", M],
  ["qwen3.7-plus", M],
  ["qwen3.7-flash", M],
  ["qwen3.7-max", M],
  ["qwen3.6-max", 256 * K],
  ["qwen3.6-plus", M],
  ["qwen3.6-flash", M],
  ["qwen3.5-plus", M],
  ["qwen3.5-flash", M],
  ["qwen3.5-397b", 256 * K],
  ["qwen3.5-122b", 256 * K],
  ["qwen3.5-27b", 256 * K],
  ["qwen3.5-35b", 256 * K],
  /* Qwen3 (international) and Qwen3-Coder. */
  ["qwen3-coder-plus", M],
  ["qwen3-coder-flash", M],
  ["qwen3-coder-next", 256 * K],
  ["qwen3-coder-480b", 256 * K],
  ["qwen3-coder-30b", 256 * K],
  ["qwen3-coder", 256 * K],
  ["qwen3-next", 256 * K],
  ["qwen3-max", 256 * K],
  ["qwen3-235b", 256 * K],
  ["qwen3-32b", 256 * K],
  ["qwen3-30b", 256 * K],
  ["qwen3-14b", 256 * K],
  ["qwen3-8b", 256 * K],
  ["qwen3-4b", 256 * K],
  ["qwen3-1.7b", 256 * K],
  ["qwen3-0.6b", 256 * K],
  /* Qwen2.5 — the international catalog serves 1M-context versions. */
  ["qwen2.5-omni", M],
  ["qwen2.5-vl", M],
  ["qwen2.5-turbo", M],
  ["qwen2.5-72b", M],
  ["qwen2.5-32b", M],
  ["qwen2.5-14b", M],
  ["qwen2.5-7b", M],
  /* Legacy Qwen. */
  ["qwen-plus-character", 32 * K],
  ["qwen-flash-character", 8 * K],
  ["qwen-plus", M],
  ["qwen-flash", M],
  ["qwen-turbo", M],
  ["qwen-max", 128 * K],
  ["qwen-mt-", 16 * K],
  ["qwen-long", 10 * M],
  ["qwen-omni-turbo", 32 * K],
  ["qvq-max", 128 * K],
  ["qwq-plus", 128 * K],
  /* Third-party families (international values). */
  ["deepseek-v4", M],
  ["deepseek-v3", 128 * K],
  ["deepseek-r1", 128 * K],
  ["deepseek", 128 * K],
  ["Moonshot-Kimi", 256 * K],
  ["kimi-k2", 256 * K],
  ["glm-", 198 * K],
  ["mimo-v2.5", M],
  /* Catch-all for any other Qwen ID; conservative 128K so compaction still
   * engages for unlisted models. Override with `modelContextWindows`. */
  ["qwen", 128 * K],
];

let configuredOverrides: ReadonlyMap<string, number> = new Map();
let fallbackContextWindow_: number | undefined;

function readPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(
      `alibaba-token-plan ${label} must be a positive integer (tokens)`,
    );
  }
  return value;
}

function parseOverrides(raw: unknown): ReadonlyMap<string, number> {
  if (raw === undefined) return new Map();
  if (!isRecord(raw)) {
    throw new Error(
      "alibaba-token-plan modelContextWindows must be an object mapping model IDs to token counts",
    );
  }
  const map = new Map<string, number>();
  for (const [modelId, value] of Object.entries(raw)) {
    map.set(
      modelId,
      readPositiveInteger(value, `modelContextWindows["${modelId}"]`),
    );
  }
  return map;
}

/* Called from plugin registration with the plugin config object. */
export function configureContext(config: Record<string, unknown>): void {
  configuredOverrides = parseOverrides(config.modelContextWindows);
  fallbackContextWindow_ =
    config.defaultContextWindow === undefined
      ? undefined
      : readPositiveInteger(
          config.defaultContextWindow,
          "defaultContextWindow",
        );
}

/* User-configured exact-ID override, if any. Always wins over both the
 * endpoint-provided value and the bundled table. */
export function configOverrideFor(modelId: string): number | undefined {
  return configuredOverrides.get(modelId);
}

/* Bundled table lookup (exact ID, then longest matching prefix), without the
 * `defaultContextWindow` fallback. */
export function bundledContextWindowFor(modelId: string): number | undefined {
  const exact = EXACT_CONTEXT_WINDOWS[modelId];
  if (exact !== undefined) return exact;
  for (const [prefix, size] of PREFIX_CONTEXT_WINDOWS) {
    if (modelId.startsWith(prefix)) return size;
  }
  return undefined;
}

/* User-configured fallback for models unknown to the bundled table. */
export function fallbackContextWindow(): number | undefined {
  return fallbackContextWindow_;
}

/* Xal exposes `/context-window` only when a model carries a ladder of
 * selectable windows (`contextWindows`): the first rung is the default context
 * budget and the last rung the model maximum. A ladder exists only when the
 * maximum exceeds the budget, mirroring Xal's own OpenAI provider. The budget
 * default follows the Model Studio guidance that 128K-256K covers standard
 * tasks; the physical maximum stays reachable through `/context-window`. */
const DEFAULT_CONTEXT_BUDGET = 256_000;
const CONTEXT_LADDER_RUNGS = [400_000, 600_000, 800_000];

export function contextWindowsFor(maxWindow: number): number[] | undefined {
  const budget = Math.min(maxWindow, DEFAULT_CONTEXT_BUDGET);
  if (budget >= maxWindow) return undefined;
  const ladder = [...new Set([budget, ...CONTEXT_LADDER_RUNGS, maxWindow])]
    .filter((size) => size >= budget && size <= maxWindow)
    .sort((left, right) => left - right);
  return ladder.length > 1 ? ladder : undefined;
}
