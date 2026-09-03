import { asNumber, asString, isRecord } from "./types";
import { goBaseUrl, zenBaseUrl } from "./config";

export type OpenCodeSource = "zen" | "go";

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
  "deepseek-v4-flash-free": "DeepSeek V4 Flash",
  "muse-spark-1.3-contributor-free": "Muse Spark 1.3 Contributor",
  "muse-spark-1.2-contributor-free": "Muse Spark 1.2 Contributor",
  "mimo-v2.5-free": "MiMo V2.5",
  "hy3-free": "Hy3",
  "nemotron-3-ultra-free": "Nemotron 3 Ultra",
  "nemotron-3.5-lightning-free": "Nemotron 3.5 Lightning",
  "laguna-s-2.1-free": "Laguna S 2.1",
  "big-pickle": "Big Pickle",
  "ox-alpha-free": "Ox Alpha",
};

/* Per-source display label appended to the Xal-visible name so users always
 * see which source a model came from. */
export function sourceLabel(source: OpenCodeSource): string {
  return source === "zen" ? "Zen Free" : "Go Free";
}

function humanize(id: string): string {
  const base = id
    .replace(/-free(-|$)/g, (match) => (match === "-free" ? "" : "-"))
    .replace(/[-_.]+/g, " ")
    .trim();
  return base === ""
    ? id
    : base
        .split(" ")
        .map((part) => {
          const lower = part.toLowerCase();
          return /^(v)?[0-9]+(\.[0-9]+)?$/.test(lower) || /^v[0-9]/.test(lower)
            ? part
            : part.charAt(0).toUpperCase() + part.slice(1);
        })
        .join(" ");
}

export function displayNameFor(
  source: OpenCodeSource,
  upstreamId: string,
): string {
  const base = NAME_OVERRIDES[upstreamId] ?? humanize(upstreamId);
  return `${base} (${sourceLabel(source)})`;
}

export function baseUrlFor(source: OpenCodeSource): string {
  return source === "zen" ? zenBaseUrl() : goBaseUrl();
}

export function modelsEndpoint(source: OpenCodeSource): string {
  return `${baseUrlFor(source)}/models`;
}

/* Resolve the inference endpoint for a source + transport. The mapping mirrors
 * OpenCode's documented Zen/Go endpoints. */
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

/* Xal sees provider model IDs as `zen/<id>` / `go/<id>` to avoid collisions
 * when the same upstream model appears on both sources. */
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
  if (source !== "zen" && source !== "go") return undefined;
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
 * catalog shape returned by both /zen/v1/models and /zen/go/v1/models.
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

export function parseGoModels(input: unknown): NormalizedOpenCodeModel[] {
  return normalize("go", parseCatalog(input));
}

/* Extract just the upstream IDs from a parsed catalog (used by tests and the
 * debug command). */
export function upstreamIds(models: NormalizedOpenCodeModel[]): string[] {
  return models.map((model) => model.upstreamId);
}
