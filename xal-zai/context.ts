import { isRecord } from "./types";

/* Context window resolution for models discovered from `/models`.
 *
 * The OpenAI-compatible `/models` response carries only model IDs; z.ai exposes
 * no context-length field, so Xal's compaction and context budget would have no
 * anchor. This module supplies the missing numbers from a bundled table
 * verified against the Z.AI docs (snapshot 2026-09), plus per-model config
 * overrides for other endpoints or custom deployments.
 *
 * Values are the maximum context the endpoint serves. Xal's session budget uses
 * a conservative default (min of the maximum and 256K) so compaction engages
 * early, and a `contextWindows` ladder lets `/context-window` raise the budget
 * up to the maximum, mirroring Xal's own OpenAI provider.
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

/* Prefix rules match the model ID, longest prefix first, so snapshot IDs such
 * as `glm-4.5-2026-xx-xx` inherit their family's window. */
const PREFIX_CONTEXT_WINDOWS: ReadonlyArray<readonly [string, number]> = [
  /* Flagship / latest (verified 2026-09). */
  ["glm-5.3-", M],
  ["glm-5.3", M],
  ["glm-5.2", M],
  ["glm-5.1", 200 * K],
  ["glm-5", 200 * K],
  /* GLM-4.7 / 4.6 family. */
  ["glm-4.7-", 200 * K],
  ["glm-4.7", 200 * K],
  ["glm-4.6", 200 * K],
  /* GLM-4.5 family. */
  ["glm-4.5", 128 * K],
  ["glm-4-32b-0414-128k", 128 * K],
  /* Vision models. */
  ["glm-4.6v", 128 * K],
  ["glm-4.5v", 64 * K],
  /* Catch-all for any other GLM ID; conservative 128K so compaction still
   * engages for unlisted models. Override with `modelContextWindows`. */
  ["glm-", 128 * K],
  /* Catch-all for non-GLM IDs leaked by the catalog; 128K fallback. */
  ["cogview", 8 * K],
  ["cogvideo", 8 * K],
];

let configuredOverrides: ReadonlyMap<string, number> = new Map();
let fallbackContextWindow_: number | undefined;

function readPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`zai ${label} must be a positive integer (tokens)`);
  }
  return value;
}

function parseOverrides(raw: unknown): ReadonlyMap<string, number> {
  if (raw === undefined) return new Map();
  if (!isRecord(raw)) {
    throw new Error(
      "zai modelContextWindows must be an object mapping model IDs to token counts",
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
 * maximum exceeds the budget, mirroring Xal's own OpenAI provider. */
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
