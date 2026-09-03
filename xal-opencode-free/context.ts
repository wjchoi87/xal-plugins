import { isRecord } from "./types";

/* Context window resolution for catalog models.
 *
 * The OpenCode Zen/Go `/models` response is not guaranteed to carry a context
 * length: the public catalog exposes only IDs, and even an authenticated
 * catalog may omit it. Xal's compaction and `/context-window` need a number to
 * anchor to, so this module supplies the missing values with a source
 * precedence that keeps a catalog-provided value authoritative:
 *
 *   1. `modelContextWindows` config override for the exact upstream model ID
 *   2. the raw context window parsed from the catalog entry (if any)
 *   3. the bundled table (family-aware)
 *   4. `defaultContextWindow` config fallback (when bundled table can't tell)
 *   5. a conservative 128K catch-all so compaction always engages
 *
 * Source precedence is deliberately catalog-first: unlike the Alibaba/z.ai
 * endpoints (which never return a context length), OpenCode may eventually
 * serve real numbers, and a real upstream value should win over our guesses.
 *
 * Policy change:
 * - before: ModelInfo.contextWindow was never populated for any catalog model,
 *   so Xal had no context budget, could not compact, and `/context-window` was
 *   unsupported
 * - after: known models carry a context window (budget) plus a selectable
 *   ladder when their maximum exceeds the default budget; unknown IDs fall back
 *   to `defaultContextWindow` and then to a conservative 128K catch-all
 * - reason: the catalog may not report context windows, yet Xal needs them for
 *   correct compaction, `/context-window`, and `/compaction-limit`
 * - scope: every free model returned to Xal, both live and cached */

const K = 1024;
const M = 1_000_000;

/* Family-aware table keyed by upstream model ID (prefix rules match longest
 * first). Values are the actual maximum context window, sourced from upstream
 * model specs rather than guesswork:
 *
 * - deepseek-v4-* : DeepSeek V4 Flash/Pro "CONTEXT LENGTH" 1M
 *                  (api-docs.deepseek.com/quick_start/pricing, 2026-09)
 * - nemotron-3-ultra-free : NVIDIA Nemotron 3 Ultra 550B max_position_embeddings
 *                          262144 (HF nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B)
 * - nemotron-3.5-lightning-free : 30B-A3B max_position_embeddings 1,048,576
 *                  (HF nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B)
 * - ling-3.0-flash-fin-free : inclusionAI/Ling-3.0-flash max_position_embeddings
 *                            262144 (HF)
 * - mimo-v2.5-free : XiaomiMiMo/MiMo-V2.5 max_position_embeddings 1,048,576 (HF)
 * - muse-spark-*-contributor-free : Meta Muse Spark contributor tier; 1,048,576
 *                  confirmed by live probing (input accepted to ~1,047,798
 *                  tokens, rejected past it)
 *
 * Values are always overridable via `modelContextWindows`. Unknown families fall
 * through to `DEFAULT_CATCH_ALL`. */
const PREFIX_CONTEXT_WINDOWS: ReadonlyArray<readonly [string, number]> = [
  /* Known free favorites (verified upstream specs). */
  ["muse-spark-1.3-contributor-free", 1_048_576],
  ["muse-spark-1.2-contributor-free", 1_048_576],
  ["nemotron-3.5-lightning-free", 1_048_576],
  ["nemotron-3-ultra-free", 262_144],
  ["ling-3.0-flash-fin-free", 262_144],
  ["mimo-v2.5-free", M],
  ["mimo-", M],
  ["deepseek-v4-", M],
  ["deepseek-", 128 * K],
  /* big-pickle is a stealth model (no public spec); 1M per operator decision. */
  ["big-pickle", M],
];

/* Conservative fallback so every free model gets a compaction budget even when
 * the catalog says nothing and no family rule matches. Override this with
 * `defaultContextWindow` for a specific deployment. */
const DEFAULT_CATCH_ALL = 128 * K;

let configuredOverrides: ReadonlyMap<string, number> = new Map();
let fallbackContextWindow_: number | undefined;

function readPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(
      `opencode-free ${label} must be a positive integer (tokens)`,
    );
  }
  return value;
}

function parseOverrides(raw: unknown): ReadonlyMap<string, number> {
  if (raw === undefined) return new Map();
  if (!isRecord(raw)) {
    throw new Error(
      "opencode-free modelContextWindows must be an object mapping model IDs to token counts",
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

/* User-configured exact-ID override (keyed by upstream ID, no `zen/` prefix).
 * Always wins over both the catalog value and the bundled table. */
export function configOverrideFor(modelId: string): number | undefined {
  return configuredOverrides.get(modelId);
}

/* Bundled table lookup (longest matching prefix), without the `defaultContextWindow`
 * config fallback and without the generic catch-all. */
export function bundledContextWindowFor(modelId: string): number | undefined {
  for (const [prefix, size] of PREFIX_CONTEXT_WINDOWS) {
    if (modelId.startsWith(prefix)) return size;
  }
  return undefined;
}

/* User-configured fallback for models unknown to the bundled table, if set. */
export function fallbackContextWindow(): number | undefined {
  return fallbackContextWindow_;
}

/* Generic catch-all so every free model gets a compaction budget. */
export function catchAllContextWindow(): number {
  return DEFAULT_CATCH_ALL;
}

/* Models whose input context window cannot be raised or reconfigured by the
 * caller (the upstream rejects any context-window parameter). For these the
 * plugin must NOT advertise a `contextWindows` ladder — Xal then treats the
 * model as having a single fixed window and won't attempt to reconfigure it.
 *
 * Verified by live probing: Muse Spark contributor models (served over
 * `/responses`) reject `max_input_tokens` with "unknown parameter", so the
 * request fails with "does not support configurable context windows". */
const FIXED_CONTEXT_ONLY: ReadonlySet<string> = new Set([
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
]);

/* True when the model's context window is fixed and cannot be reconfigured.
 * Such models are exposed with a single `contextWindow` and no ladder. */
export function isFixedContextOnly(modelId: string): boolean {
  return FIXED_CONTEXT_ONLY.has(modelId);
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
