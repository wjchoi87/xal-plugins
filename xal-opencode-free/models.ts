import { describeError, fetchCatalog, raiseForStatus } from "./api";
import { apiKey } from "./auth";
import { debugModels } from "./config";
import {
  evaluateFree,
  isExposedFree,
  type FreeEvaluation,
  type FreeStatus,
} from "./free-evaluator";
import {
  displayNameFor,
  modelsEndpoint,
  parseProviderModelId,
  parseZenModels,
  resolveTransport,
  toProviderModelId,
  type NormalizedOpenCodeModel,
  type OpenCodeSource,
} from "./model-sources";
import {
  isCacheFresh,
  readMergedCache,
  readSourceCache,
  writeMergedCache,
  writeSourceCache,
} from "./cache";
import {
  syncUpstreamMetadata,
  upstreamMetadataFor,
  type MetadataReport,
} from "./metadata";
import {
  bundledContextWindowFor,
  catchAllContextWindow,
  configOverrideFor,
  contextWindowsFor,
  fallbackContextWindow,
  isFixedContextOnly,
} from "./context";
import { PROVIDER_NAME } from "./provider";
import type {
  ModelCatalog,
  ModelInfo,
  ThinkingEffort,
  ThinkingOptions,
} from "./types";

const CATALOG_TIMEOUT_MS = 10_000;
const USER_AGENT = "xal-opencode-free/0.1.0";

const SOURCE_NAMES: Record<OpenCodeSource, string> = {
  zen: "OpenCode Zen",
};

/* Policy change:
 * - before: default model preference was deepseek-v4-flash-free, then
 *   mimo-v2.5-free
 * - after: deepseek-v4.1-flash-free, then glm-5.3-flash-free
 * - reason: both previous defaults are retired (models.dev status =
 *   "deprecated", 2026-10) and are now excluded from the catalog
 * - scope: only `defaultModel()` when the user has not picked a model; when
 *   neither is available the first exposed model is used, as before */
const DEFAULT_PREFERENCE = [
  "zen/deepseek-v4.1-flash-free",
  "zen/glm-5.3-flash-free",
];

export type CatalogOrigin = "runtime" | "cache" | "failed";

let lastProfileId: string | undefined;

/** Last profile touched by a model operation; used by the debug command. */
export function activeProfileId(): string | undefined {
  return lastProfileId;
}

export interface ModelEvaluationRecord {
  model: NormalizedOpenCodeModel;
  evaluation: FreeEvaluation;
}

export interface SourceReport {
  source: OpenCodeSource;
  origin: CatalogOrigin;
  error?: string;
  /** Every model evaluated, in catalog order. */
  evaluations: ModelEvaluationRecord[];
}

function sourceName(source: OpenCodeSource): string {
  return SOURCE_NAMES[source];
}

function evaluateModels(
  models: NormalizedOpenCodeModel[],
): ModelEvaluationRecord[] {
  return models.map((model) => ({ model, evaluation: evaluateFree(model) }));
}

/* Effort levels Xal can express (its `/thinking` picker). Values outside
 * this set (e.g. GLM's "minimal") cannot be offered and are dropped. */
const XAL_THINKING_EFFORTS: ReadonlySet<string> = new Set([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/* Offline fallback mirroring models.dev `reasoning_options` for the default
 * free models; the synced metadata (metadata.ts) wins when available. */
const BUNDLED_REASONING_EFFORTS: Record<string, readonly string[]> = {
  "deepseek-v4.1-flash-free": ["low", "high", "max"],
  "glm-5.3-flash-free": ["low", "high", "max"],
};

/* Policy change:
 * - before: ModelInfo never advertised `thinking`, so Xal answered "/thinking"
 *   with "does not support configurable thinking" even for models whose
 *   upstream accepts a reasoning effort
 * - after: models with selectable effort levels (models.dev
 *   `reasoning_options` of type "effort", or the bundled fallback) expose a
 *   `thinking` picker limited to the levels the upstream actually accepts;
 *   the chosen level is sent as `reasoning_effort`
 * - reason: the effort list is per-model (e.g. GLM-5.3/DeepSeek accept only
 *   low/high/max; offering Xal's full set would 400 on the others), and
 *   models.dev publishes it per model
 * - default: the upstream's own default when offered — "max" first (GLM's
 *   documented default), then "high", then the middle level
 * - scope: models served on the chat-completions transport (the only
 *   transport that forwards `reasoning_effort`); always-thinking models
 *   (empty options, e.g. big-pickle/mimo) and toggle-only models stay
 *   without a picker */
function thinkingOptionsFor(
  source: OpenCodeSource,
  upstreamId: string,
): ThinkingOptions | undefined {
  if (resolveTransport(source, upstreamId) !== "chat-completions")
    return undefined;
  const efforts =
    upstreamMetadataFor(source, upstreamId)?.reasoningEfforts ??
    BUNDLED_REASONING_EFFORTS[upstreamId] ??
    [];
  const options = [
    ...new Set(efforts.filter((effort) => XAL_THINKING_EFFORTS.has(effort))),
  ];
  if (options.length === 0) return undefined;
  const def = (
    options.includes("max")
      ? "max"
      : options.includes("high")
        ? "high"
        : (options[Math.floor(options.length / 2)] as ThinkingEffort)
  ) as ThinkingEffort;
  return { options: options as ThinkingEffort[], default: def };
}

/* Fill in the context window the catalog may never report. Source precedence
 * (see context.ts): config override, then a catalog-provided value, then the
 * synced models.dev limit (metadata.ts), then the bundled family table, then
 * `defaultContextWindow`, then a conservative
 * catch-all so compaction always has a budget. Models that cannot have their
 * context window reconfigured (e.g. Muse Spark — see `isFixedContextOnly`) are
 * exposed with a single fixed `contextWindow` and no `contextWindows` ladder, so
 * Xal never tries to reconfigure them. */
/* Names are derived here rather than taken from `model.displayName` so a
 * cached catalog picks up the latest synced official names too. */
function withContextWindow(model: NormalizedOpenCodeModel): ModelInfo {
  const maximum =
    configOverrideFor(model.upstreamId) ??
    model.contextWindow ??
    upstreamMetadataFor(model.source, model.upstreamId)?.contextWindow ??
    bundledContextWindowFor(model.upstreamId) ??
    fallbackContextWindow() ??
    catchAllContextWindow();
  const thinking = thinkingOptionsFor(model.source, model.upstreamId);
  if (isFixedContextOnly(model.upstreamId)) {
    return {
      kind: "text",
      id: toProviderModelId(model.source, model.upstreamId),
      name: displayNameFor(model.source, model.upstreamId),
      contextWindow: maximum,
      inputModalities: [...model.inputModalities],
      ...(thinking === undefined ? {} : { thinking }),
    };
  }
  const contextWindows = contextWindowsFor(maximum);
  const budget = contextWindows?.[0] ?? maximum;
  return {
    kind: "text",
    id: toProviderModelId(model.source, model.upstreamId),
    name: displayNameFor(model.source, model.upstreamId),
    contextWindow: budget,
    ...(contextWindows === undefined ? {} : { contextWindows }),
    inputModalities: [...model.inputModalities],
    ...(thinking === undefined ? {} : { thinking }),
  };
}

function toModelInfo(model: NormalizedOpenCodeModel): ModelInfo {
  return withContextWindow(model);
}

/* Evaluation needs the synced metadata, so every path waits for it; the
 * catalog fetch itself overlaps with the metadata sync. */
async function fetchSource(
  source: OpenCodeSource,
  profileId: string,
  refresh: boolean,
  metadataReady: Promise<MetadataReport>,
): Promise<SourceReport> {
  const cached = await readSourceCache(source);
  if (!refresh && cached !== undefined && isCacheFresh(cached)) {
    await metadataReady;
    return {
      source,
      origin: "cache",
      evaluations: evaluateModels(cached.models),
    };
  }
  try {
    const signal = AbortSignal.timeout(CATALOG_TIMEOUT_MS);
    const response = await fetchCatalog(
      sourceName(source),
      modelsEndpoint(source),
      {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${await apiKey(profileId)}`,
          "user-agent": USER_AGENT,
        },
        signal,
      },
    );
    if (!response.ok) await raiseForStatus(sourceName(source), response);
    const raw: unknown = await response.json();
    const parsed = parseZenModels(raw);
    await writeSourceCache(source, parsed);
    await metadataReady;
    return { source, origin: "runtime", evaluations: evaluateModels(parsed) };
  } catch (error) {
    if (cached) {
      await metadataReady;
      return {
        source,
        origin: "cache",
        error: describeError(error),
        evaluations: evaluateModels(cached.models),
      };
    }
    return {
      source,
      origin: "failed",
      error: describeError(error),
      evaluations: [],
    };
  }
}

function freeModels(report: SourceReport): ModelInfo[] {
  return report.evaluations
    .filter((record) => isExposedFree(record.evaluation))
    .map((record) => toModelInfo(record.model));
}

function sortModels(models: ModelInfo[]): ModelInfo[] {
  return [...models].sort((left, right) => left.id.localeCompare(right.id));
}

function dedupe(models: ModelInfo[]): ModelInfo[] {
  const seen = new Set<string>();
  const out: ModelInfo[] = [];
  for (const model of models) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(model);
  }
  return out;
}

function buildWarnings(
  reports: SourceReport[],
  metadata: MetadataReport,
): string[] {
  const warnings: string[] = [];
  if (metadata.origin === "failed") {
    warnings.push(
      "models.dev metadata unavailable; using bundled context limits.",
    );
  } else if (metadata.origin === "cache" && metadata.error) {
    warnings.push("models.dev metadata refresh failed; using cached metadata.");
  }
  for (const report of reports) {
    const label = sourceName(report.source);
    if (report.origin === "runtime") {
      warnings.push(`${label} catalog refreshed successfully.`);
    } else if (report.origin === "cache" && report.error) {
      warnings.push(`${label} catalog unavailable; using cached models.`);
    } else if (report.origin === "failed") {
      warnings.push(`${label} catalog unavailable.`);
    }
  }
  return warnings;
}

/* Policy change:
 * - before: both the Zen and the Go catalogs were fetched and their free
 *   models merged into one list
 * - after: only the Zen catalog is fetched; the Go source is not queried
 * - reason: every Go model — including the `*-free` ones — is served only
 *   while a Go plan subscription is active, so none of them belong in a
 *   free-models provider
 * - scope: catalog resolution; the merged-cache fallback additionally drops
 *   stale `go/<id>` entries written by older plugin versions */
async function resolveCatalog(
  profileId: string,
  refresh: boolean,
): Promise<{
  models: ModelInfo[];
  reports: SourceReport[];
  metadata: MetadataReport;
  fallback: boolean;
}> {
  const metadataReady = syncUpstreamMetadata(refresh);
  const reports: SourceReport[] = [
    await fetchSource("zen", profileId, refresh, metadataReady),
  ];
  const metadata = await metadataReady;
  let models = sortModels(dedupe(reports.flatMap(freeModels)));

  // Persist the last known-good merged list when we produced a fresh (non
  // cached) result that is not empty, for a future all-failed fallback.
  const anyRuntime = reports.some((report) => report.origin === "runtime");
  const hadResults = reports.some((report) => report.origin !== "failed");
  if (hadResults && models.length > 0) {
    await writeMergedCache(models);
  }

  // Both sources failed (or yielded nothing usable): fall back to the last
  // known-good merged free list.
  let fallback = false;
  if (models.length === 0 && anyRuntime === false) {
    const merged = await readMergedCache();
    if (merged && merged.models.length > 0) {
      models = merged.models
        .filter((model) => isFallbackEligible(model.id))
        .map((model) => ({ ...model, kind: "text" }));
      fallback = models.length > 0;
    }
  }
  void anyRuntime;
  return { models, reports, metadata, fallback };
}

/* The merged fallback list was written before the latest metadata sync; drop
 * anything that has since been retired or found unservable. Ids this plugin
 * can no longer route (stale `go/<id>` entries from older versions) are
 * dropped too. */
function isFallbackEligible(providerModelId: string): boolean {
  const parsed = parseProviderModelId(providerModelId);
  if (!parsed) return false;
  const upstream = upstreamMetadataFor(parsed.source, parsed.upstreamId);
  return !(
    upstream?.deprecated === true || upstream?.protocol === "unsupported"
  );
}

export async function listModels(
  profileId: string,
  refresh: boolean,
): Promise<ModelCatalog> {
  lastProfileId = profileId;
  try {
    const { models, reports, metadata, fallback } = await resolveCatalog(
      profileId,
      refresh,
    );
    const warnings = buildWarnings(reports, metadata);
    if (debugModels()) {
      warnings.push(...debugWarnings(reports));
    }
    const source: ModelCatalog["source"] = fallback
      ? "bundled"
      : reports.some((report) => report.origin === "runtime")
        ? "runtime"
        : "cache";
    return {
      models,
      source,
      ...(warnings.length === 0 ? {} : { warning: warnings.join("; ") }),
    };
  } catch (error) {
    return {
      models: [],
      source: "runtime",
      warning: `model discovery failed: ${describeError(error)}`,
    };
  }
}

export async function defaultModel(profileId: string): Promise<string> {
  lastProfileId = profileId;
  try {
    const { models } = await resolveCatalog(profileId, false);
    for (const id of DEFAULT_PREFERENCE) {
      if (models.some((model) => model.id === id)) return id;
    }
    const first = models[0];
    if (first) return first.id;
  } catch (error) {
    throw new Error(
      `${PROVIDER_NAME} has no verified free models (${describeError(error)})`,
      { cause: error },
    );
  }
  throw new Error("No verified free OpenCode models are currently available.");
}

export async function getReports(
  profileId: string,
  refresh: boolean,
): Promise<SourceReport[]> {
  const { reports } = await resolveCatalog(profileId, refresh);
  return reports;
}

function debugWarnings(reports: SourceReport[]): string[] {
  const lines: string[] = [];
  for (const report of reports) {
    const dropped = report.evaluations.filter(
      (record) => record.evaluation.status !== "free",
    );
    if (dropped.length === 0) continue;
    for (const record of dropped) {
      lines.push(
        `? ${toProviderModelId(report.source, record.model.upstreamId)} reason=${record.evaluation.reason}`,
      );
    }
  }
  return lines;
}

export function modelCountByStatus(
  report: SourceReport,
): Record<FreeStatus, number> {
  const counts: Record<FreeStatus, number> = {
    free: 0,
    paid: 0,
    unknown: 0,
    excluded: 0,
  };
  for (const record of report.evaluations) {
    counts[record.evaluation.status] += 1;
  }
  return counts;
}
