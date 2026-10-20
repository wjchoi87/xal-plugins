import { describeError } from "./api";
import { readMetadataCache, writeMetadataCache } from "./cache";
import {
  modelMetadataTtlMs,
  modelMetadataUrl,
  syncModelMetadata,
} from "./config";
import type { OpenCodeSource, TransportKind } from "./model-sources";
import { asNumber, asString, isRecord } from "./types";

/* Runtime sync with OpenCode's own model metadata.
 *
 * OpenCode publishes per-model serving limits, retirement status, and protocol
 * for its gateway in models.dev (`opencode` = Zen) — the same catalog
 * OpenCode's own client loads at runtime. The `/zen/v1/models` catalog only
 * lists IDs, so this module fills in what it lacks.
 *
 * Policy change:
 * - before: context windows, retired models, and non-chat protocols came only
 *   from tables bundled in the plugin, so every upstream change (new free
 *   model, lowered limit, retirement) needed a plugin edit and reinstall
 * - after: on catalog resolution the plugin syncs models.dev (cached for
 *   `modelMetadataTtlMs`, default 12h; forced on `/models` refresh) and uses
 *   it for (1) the context window, (2) hiding `status = "deprecated"` models,
 *   and (3) routing each model to the protocol it is served on, excluding
 *   protocols this plugin cannot stream
 * - reason: keep the free list, compaction budgets, and request routing in
 *   step with OpenCode automatically
 * - scope: every Zen model the catalog lists. When models.dev is unreachable
 *   the last cached snapshot is used, then the bundled tables;
 *   `syncModelMetadata: false` turns the sync off entirely. The OpenCode API
 *   key is never sent to models.dev. */

export type UpstreamProtocol = TransportKind | "unsupported";

export interface UpstreamModelMetadata {
  deprecated: boolean;
  /* Official display name, e.g. "GLM-5.3-Flash Free". */
  name?: string;
  contextWindow?: number;
  protocol?: UpstreamProtocol;
  /* Reasoning effort levels the model accepts (models.dev
   * `reasoning_options[].type === "effort"`), e.g. ["low","high","max"].
   * Absent when the model's thinking is not configurable (always-on
   * `reasoning: true` with no options, or a mere on/off toggle). */
  reasoningEfforts?: string[];
}

export type UpstreamMetadata = Record<
  OpenCodeSource,
  Record<string, UpstreamModelMetadata>
>;

export type MetadataOrigin = "runtime" | "cache" | "disabled" | "failed";

export interface MetadataReport {
  origin: MetadataOrigin;
  error?: string;
}

const PROVIDER_IDS: Record<OpenCodeSource, string> = {
  zen: "opencode",
};

const METADATA_TIMEOUT_MS = 15_000;
const USER_AGENT = "xal-opencode-free/0.1.0";

let snapshot: UpstreamMetadata | undefined;

export function upstreamMetadataFor(
  source: OpenCodeSource,
  upstreamId: string,
): UpstreamModelMetadata | undefined {
  return snapshot?.[source][upstreamId];
}

/* Map the AI SDK package / endpoint models.dev assigns a model to the protocol
 * the gateway serves it on. System One (structured decisions) and Gemini have
 * no streaming transport here, so they are reported as unsupported. Unknown
 * packages return undefined and keep the bundled routing. */
function protocolFor(
  npm: string | undefined,
  api: string | undefined,
): UpstreamProtocol | undefined {
  if (api?.includes("/systemone/") || api?.includes("/google/"))
    return "unsupported";
  switch (npm) {
    case "@ai-sdk/anthropic":
      return "anthropic-messages";
    case "@ai-sdk/openai":
      return "responses";
    case "@ai-sdk/openai-compatible":
      return "chat-completions";
    case "@ai-sdk/google":
      return "unsupported";
    default:
      return undefined;
  }
}

/* Flatten the models.dev `reasoning_options` list into the plain effort
 * levels the model accepts. Only `type: "effort"` entries carry selectable
 * levels; `toggle` (thinking on/off) and empty lists mean thinking is not
 * effort-configurable and yield undefined. */
function reasoningEffortsFor(
  entry: Record<string, unknown>,
): string[] | undefined {
  if (!Array.isArray(entry.reasoning_options)) return undefined;
  const efforts = entry.reasoning_options.flatMap((option): string[] => {
    if (!isRecord(option) || option.type !== "effort") return [];
    return Array.isArray(option.values)
      ? option.values.flatMap((value) => {
          const effort = asString(value);
          return effort ? [effort] : [];
        })
      : [];
  });
  return efforts.length > 0 ? [...new Set(efforts)] : undefined;
}

/* Reduce the models.dev `api.json` (all providers, several MB) to the
 * OpenCode Zen provider. A missing or malformed provider block yields an
 * empty map; a response without any OpenCode model fails. */
export function parseModelsDev(input: unknown): UpstreamMetadata {
  if (!isRecord(input))
    throw new Error("models.dev response was not an object");
  const result: UpstreamMetadata = { zen: {} };
  for (const source of ["zen"] as const) {
    const provider = input[PROVIDER_IDS[source]];
    if (!isRecord(provider) || !isRecord(provider.models)) continue;
    const providerNpm = asString(provider.npm);
    const providerApi = asString(provider.api);
    for (const [id, entry] of Object.entries(provider.models)) {
      if (!isRecord(entry)) continue;
      const override = isRecord(entry.provider) ? entry.provider : {};
      const context = isRecord(entry.limit)
        ? asNumber(entry.limit.context)
        : undefined;
      const protocol = protocolFor(
        asString(override.npm) ?? providerNpm,
        asString(override.api) ?? providerApi,
      );
      const name = asString(entry.name)?.trim();
      const reasoningEfforts = reasoningEffortsFor(entry);
      result[source][id] = {
        deprecated: entry.status === "deprecated",
        ...(name ? { name } : {}),
        ...(context !== undefined && context > 0
          ? { contextWindow: context }
          : {}),
        ...(protocol === undefined ? {} : { protocol }),
        ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
      };
    }
  }
  if (Object.keys(result.zen).length === 0)
    throw new Error("models.dev response contained no OpenCode models");
  return result;
}

/* Refresh the in-memory snapshot from cache or models.dev. Never throws: a
 * failed sync falls back to the last cached snapshot (any age), then to none,
 * in which case callers use the bundled tables. */
export async function syncUpstreamMetadata(
  refresh: boolean,
): Promise<MetadataReport> {
  if (!syncModelMetadata()) {
    snapshot = undefined;
    return { origin: "disabled" };
  }
  const cached = await readMetadataCache();
  if (
    !refresh &&
    cached !== undefined &&
    Date.now() - cached.fetchedAt < modelMetadataTtlMs()
  ) {
    snapshot = cached.sources;
    return { origin: "cache" };
  }
  let fresh: UpstreamMetadata;
  try {
    const response = await fetch(modelMetadataUrl(), {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    });
    if (!response.ok)
      throw new Error(`models.dev returned HTTP ${response.status}`);
    fresh = parseModelsDev(await response.json());
  } catch (error) {
    if (cached) snapshot = cached.sources;
    return snapshot
      ? { origin: "cache", error: describeError(error) }
      : { origin: "failed", error: describeError(error) };
  }
  snapshot = fresh;
  // A cache write failure must not discard freshly synced metadata.
  await writeMetadataCache(fresh).catch(() => undefined);
  return { origin: "runtime" };
}

/* Stream requests can arrive before any catalog resolution in this process
 * (e.g. a resumed session); load the cached snapshot without touching the
 * network so protocol routing still follows the synced metadata. */
export async function ensureUpstreamMetadata(): Promise<void> {
  if (snapshot !== undefined || !syncModelMetadata()) return;
  const cached = await readMetadataCache();
  if (cached) snapshot = cached.sources;
}

/* Test hook: replace the in-memory snapshot. */
export function setUpstreamMetadata(value: UpstreamMetadata | undefined): void {
  snapshot = value;
}
