import { asNumber, asString, isRecord } from "./types";
import { zenBaseUrl } from "./config";
import { upstreamMetadataFor } from "./metadata";

/* Policy change:
 * - before: the plugin served two sources — Zen (`zen/<id>`) and Go
 *   (`go/<id>`) — exposing Go models that looked free
 * - after: only Zen remains; the Go source is gone entirely (catalog fetch,
 *   auth probe, metadata sync, and `go/<id>` routing all removed)
 * - reason: every OpenCode Go model — including the `*-free` ones — is
 *   served only while a Go plan subscription is active, so "free" Go entries
 *   were never usable through this plugin without a paid subscription
 * - scope: model discovery and routing; existing `zen/<id>` ids are
 *   unaffected, stale `go/<id>` ids (cached catalogs, saved sessions) are
 *   rejected by `parseProviderModelId` */
export type OpenCodeSource = "zen";

export type TransportKind =
  "responses" | "chat-completions" | "anthropic-messages";

export const DEFAULT_TRANSPORT: TransportKind = "chat-completions";

export interface NormalizedPricing {
  /* Defined as in upstream cost model. `undefined` fields are treated as
   * "missing" for free evaluation — never as zero. */
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  currency?: string;
}

export interface NormalizedOpenCodeModel {
  source: OpenCodeSource;
  upstreamId: string;
  displayName: string;
  contextWindow?: number;
  inputModalities: Array<"text" | "image">;
  transport: TransportKind;
  pricing?: NormalizedPricing;
  rawMetadata: unknown;
}

/* Display-name overrides for the currently known free-model families. These
 * are cosmetic only — they never influence free/paid classification. Fallback
 * is a humanized version of the upstream ID. */
const NAME_OVERRIDES: Record<string, string> = {
  "deepseek-v4.1-flash-free": "DeepSeek V4.1 Flash",
  "glm-5.3-flash-free": "GLM 5.3 Flash",
  "mimo-v2.6-flash-free": "MiMo V2.6 Flash",
  "muse-spark-1.3-contributor-free": "Muse Spark 1.3 Contributor",
  "nemotron-3-ultra-free": "Nemotron 3 Ultra",
  "nemotron-3.5-lightning-free": "Nemotron 3.5 Lightning",
  "big-pickle": "Big Pickle",
};

/* Per-source display label appended to the Xal-visible name so users always
 * see which source a model came from. */
export function sourceLabel(source: OpenCodeSource): string {
  void source;
  return "Zen Free";
}

/* Dots are kept so version numbers survive ("mimo-v2.6-flash-free" ->
 * "Mimo V2.6 Flash", not "Mimo V2 6 Flash"). */
function humanize(id: string): string {
  const base = id
    .replace(/-free(-|$)/g, (match) => (match === "-free" ? "" : "-"))
    .replace(/[-_]+/g, " ")
    .trim();
  return base === ""
    ? id
    : base
        .split(" ")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
}

/* The official name synced from models.dev, minus the trailing "Free" the
 * source label already conveys ("GLM-5.3-Flash Free" -> "GLM-5.3-Flash"). */
function syncedName(
  source: OpenCodeSource,
  upstreamId: string,
): string | undefined {
  const name = upstreamMetadataFor(source, upstreamId)?.name;
  const trimmed = name?.replace(/\s+free$/i, "").trim();
  return trimmed ? trimmed : undefined;
}

/* Policy change:
 * - before: names came from NAME_OVERRIDES, else a humanized ID that split
 *   version numbers on dots ("Nemotron 3 5 Super Vl")
 * - after: NAME_OVERRIDES, then the official models.dev name, then the
 *   humanized ID (dots kept)
 * - reason: new free models should show their real names without a plugin
 *   update; curated overrides still win where the official name drops
 *   meaning (e.g. Muse Spark's "Contributor" tier)
 * - scope: display names only; IDs, routing, and free evaluation unchanged */
export function displayNameFor(
  source: OpenCodeSource,
  upstreamId: string,
): string {
  const base =
    NAME_OVERRIDES[upstreamId] ??
    syncedName(source, upstreamId) ??
    humanize(upstreamId);
  return `${base} (${sourceLabel(source)})`;
}

export function baseUrlFor(source: OpenCodeSource): string {
  void source;
  return zenBaseUrl();
}

export function modelsEndpoint(source: OpenCodeSource): string {
  return `${baseUrlFor(source)}/models`;
}

/* Resolve the inference endpoint for a source + transport. The mapping mirrors
 * OpenCode's documented Zen endpoints. */
export function resolveEndpoint(
  source: OpenCodeSource,
  transport: TransportKind,
): string {
  const base = baseUrlFor(source);
  switch (transport) {
    case "responses":
      return `${base}/responses`;
    case "chat-completions":
      return `${base}/chat/completions`;
    case "anthropic-messages":
      return `${base}/messages`;
  }
}

/* Without wall-clock model metadata the catalog doesn't advertise a protocol,
 * so models default to the OpenAI-compatible chat-completions endpoint.
 * Per-model overrides (keyed `source/upstreamId`) opt individual free models
 * onto `/responses` or `/messages` when the upstream only serves that protocol.
 *
 * Policy change:
 * - before: every model used chat-completions, so the Muse Spark contributor
 *   models (which only serve the OpenAI `/responses` protocol) returned 500
 *   "Internal server error" from `/chat/completions`
 * - after: Muse Spark contributor models are routed to `/responses`
 * - reason: `muse-spark-*-contributor-free` accept `/zen/v1/responses` (200)
 *   but reject `chat/completions` and `/messages` (500) — verified against the
 *   live Zen catalog
 * - scope: requests for those exact upstream model IDs */
const MODEL_TRANSPORT: Record<string, TransportKind> = {
  "zen/muse-spark-1.3-contributor-free": "responses",
};

/* Resolve the transport a model is served on. The protocol synced from
 * models.dev (metadata.ts) wins; MODEL_TRANSPORT is the fallback when no
 * synced metadata is available.
 *
 * Policy change:
 * - before: routing came only from MODEL_TRANSPORT, so a new free model served
 *   on `/responses` or `/messages` was sent to `/chat/completions` and failed
 * - after: the synced protocol wins; the table above is only the fallback
 * - reason: OpenCode assigns each model one protocol and publishes it there
 * - scope: request routing and thinking-option eligibility for every model */
export function resolveTransport(
  source: OpenCodeSource,
  upstreamId: string,
): TransportKind {
  const synced = upstreamMetadataFor(source, upstreamId)?.protocol;
  if (synced !== undefined && synced !== "unsupported") return synced;
  const explicit = MODEL_TRANSPORT[`${source}/${upstreamId}`];
  return explicit ?? "chat-completions";
}

/* Xal sees provider model IDs as `zen/<id>`. */
export function toProviderModelId(
  source: OpenCodeSource,
  upstreamId: string,
): string {
  return `${source}/${upstreamId}`;
}

export interface ParsedModelId {
  source: OpenCodeSource;
  upstreamId: string;
}

export function parseProviderModelId(id: string): ParsedModelId | undefined {
  const slash = id.indexOf("/");
  if (slash <= 0 || id.startsWith("/")) return undefined;
  const source = id.slice(0, slash);
  const upstreamId = id.slice(slash + 1);
  if (source !== "zen") return undefined;
  if (!upstreamId) return undefined;
  return { source, upstreamId };
}

interface CatalogEntry {
  id: string;
  pricing?: NormalizedPricing;
  contextWindow?: number;
}

interface PricedCatalog {
  entries: CatalogEntry[];
}

/* Shared parser for the OpenAI-style `{object:"list", data:[{id,...}]}`
 * catalog shape returned by /zen/v1/models.
 * A single malformed entry is skipped rather than failing the whole catalog;
 * a structurally invalid top-level response fails the source. */
function parseCatalog(input: unknown): PricedCatalog {
  if (!isRecord(input) || !Array.isArray(input.data))
    throw new Error("catalog response was not an OpenAI-style list");
  const entries: CatalogEntry[] = [];
  for (const entry of input.data) {
    if (!isRecord(entry)) continue;
    const id = asString(entry.id);
    if (!id) continue;
    const pricing = parsePricing(entry);
    const contextWindow = parseContextWindow(entry);
    entries.push({
      id,
      ...(pricing === undefined ? {} : { pricing }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
    });
  }
  if (entries.length === 0)
    throw new Error("catalog contained no valid models");
  return { entries };
}

/* Read a context-window length if the catalog exposes one. OpenCode's catalog
 * shape is not versioned/guaranteed, so we probe the common field spellings
 * (`context_window`, `context_length`, `contextWindow`) and must be tolerant of
 * both direct numbers and nested objects. Absence is fine — the bundled table
 * and `defaultContextWindow` fill the gap. */
function parseContextWindow(
  entry: Record<string, unknown>,
): number | undefined {
  const read = (value: unknown): number | undefined => {
    const n = asNumber(value);
    if (n !== undefined && n > 0) return n;
    if (isRecord(value)) {
      const nested =
        asNumber(value.length) ??
        asNumber(value.tokens) ??
        asNumber(value.value) ??
        asNumber(value.max);
      if (nested !== undefined && nested > 0) return nested;
    }
    return undefined;
  };
  return (
    read(entry.context_window) ??
    read(entry.context_length) ??
    read(entry.contextWindow) ??
    read(entry.context) ??
    (isRecord(entry.metadata) ? read(entry.metadata) : undefined)
  );
}

function parsePricing(
  entry: Record<string, unknown>,
): NormalizedPricing | undefined {
  const raw = entry.cost ?? entry.pricing ?? entry.price;
  if (!isRecord(raw)) return undefined;
  const pricing: NormalizedPricing = {};
  const numeric = (value: unknown): number | undefined => asNumber(value);
  const input = numeric(raw.input);
  const output = numeric(raw.output);
  const cacheRead =
    numeric(raw.cache_read) ??
    (isRecord(raw.cache) ? numeric(raw.cache.read) : undefined);
  const cacheWrite =
    numeric(raw.cache_write) ??
    (isRecord(raw.cache) ? numeric(raw.cache.write) : undefined);
  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined
  )
    return undefined;
  pricing.input = input;
  pricing.output = output;
  pricing.cacheRead = cacheRead;
  pricing.cacheWrite = cacheWrite;
  pricing.currency = asString(raw.currency) ?? asString(raw.currency_symbol);
  return pricing;
}

function normalize(
  source: OpenCodeSource,
  catalog: PricedCatalog,
): NormalizedOpenCodeModel[] {
  return catalog.entries.map((entry) => ({
    source,
    upstreamId: entry.id,
    displayName: displayNameFor(source, entry.id),
    inputModalities: defaultModalities(source, entry.id),
    transport: DEFAULT_TRANSPORT,
    ...(entry.pricing === undefined ? {} : { pricing: entry.pricing }),
    ...(entry.contextWindow === undefined
      ? {}
      : { contextWindow: entry.contextWindow }),
    rawMetadata: { id: entry.id },
  }));
}

function defaultModalities(
  source: OpenCodeSource,
  id: string,
): Array<"text" | "image"> {
  // Vision-capable free previews can opt in here; default is text-only so a
  // model whose modality is unknown is never advertised as accepting images.
  const visionFreeIds = new Set<string>([]);
  void source;
  return visionFreeIds.has(id) ? ["text", "image"] : ["text"];
}

export function parseZenModels(input: unknown): NormalizedOpenCodeModel[] {
  return normalize("zen", parseCatalog(input));
}

/* Extract just the upstream IDs from a parsed catalog (used by tests and the
 * debug command). */
export function upstreamIds(models: NormalizedOpenCodeModel[]): string[] {
  return models.map((model) => model.upstreamId);
}
