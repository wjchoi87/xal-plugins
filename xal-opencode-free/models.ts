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
  modelsEndpoint,
  parseGoModels,
  parseZenModels,
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
  bundledContextWindowFor,
  catchAllContextWindow,
  configOverrideFor,
  contextWindowsFor,
  fallbackContextWindow,
} from "./context";
import { PROVIDER_NAME } from "./provider";
import type { ModelCatalog, ModelInfo } from "./types";

const CATALOG_TIMEOUT_MS = 10_000;
const USER_AGENT = "xal-opencode-free/0.1.0";

const SOURCE_NAMES: Record<OpenCodeSource, string> = {
  zen: "OpenCode Zen",
  go: "OpenCode Go",
};

const DEFAULT_PREFERENCE = ["zen/deepseek-v4-flash-free", "zen/mimo-v2.5-free"];

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

/* Fill in the context window the catalog may never report. Source precedence
 * (see context.ts): config override, then a catalog-provided value, then the
 * bundled family table, then `defaultContextWindow`, then a conservative
 * catch-all so compaction always has a budget. */
function withContextWindow(model: NormalizedOpenCodeModel): ModelInfo {
  const maximum =
    configOverrideFor(model.upstreamId) ??
    model.contextWindow ??
    bundledContextWindowFor(model.upstreamId) ??
    fallbackContextWindow() ??
    catchAllContextWindow();
  const contextWindows = contextWindowsFor(maximum);
  const budget = contextWindows?.[0] ?? maximum;
  return {
    id: toProviderModelId(model.source, model.upstreamId),
    name: model.displayName,
    contextWindow: budget,
    ...(contextWindows === undefined ? {} : { contextWindows }),
    inputModalities: [...model.inputModalities],
  };
}

function toModelInfo(model: NormalizedOpenCodeModel): ModelInfo {
  return withContextWindow(model);
}

async function fetchSource(
  source: OpenCodeSource,
  profileId: string,
  refresh: boolean,
): Promise<SourceReport> {
  const cached = await readSourceCache(source);
  if (!refresh && cached !== undefined && isCacheFresh(cached)) {
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
    const parsed = source === "zen" ? parseZenModels(raw) : parseGoModels(raw);
    await writeSourceCache(source, parsed);
    return { source, origin: "runtime", evaluations: evaluateModels(parsed) };
  } catch (error) {
    if (cached) {
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
  const order: Record<OpenCodeSource, number> = { zen: 0, go: 1 };
  return [...models].sort((left, right) => {
    const leftKey = left.id;
    const rightKey = right.id;
    const leftSource = leftKey.slice(0, leftKey.indexOf("/"));
    const rightSource = rightKey.slice(0, rightKey.indexOf("/"));
    const ls =
      leftSource === "zen" || leftSource === "go"
        ? (order[leftSource] ?? 2)
        : 2;
    const rs =
      rightSource === "zen" || rightSource === "go"
        ? (order[rightSource] ?? 2)
        : 2;
    if (ls !== rs) return ls - rs;
    return left.id.localeCompare(right.id);
  });
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

function buildWarnings(reports: SourceReport[]): string[] {
  const warnings: string[] = [];
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

async function resolveCatalog(
  profileId: string,
  refresh: boolean,
): Promise<{
  models: ModelInfo[];
  reports: SourceReport[];
  fallback: boolean;
}> {
  const reports: SourceReport[] = [
    await fetchSource("zen", profileId, refresh),
    await fetchSource("go", profileId, refresh),
  ];
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
      models = merged.models;
      fallback = true;
    }
  }
  void anyRuntime;
  return { models, reports, fallback };
}

export async function listModels(
  profileId: string,
  refresh: boolean,
): Promise<ModelCatalog> {
  lastProfileId = profileId;
  try {
    const { models, reports, fallback } = await resolveCatalog(
      profileId,
      refresh,
    );
    const warnings = buildWarnings(reports);
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
  const counts: Record<FreeStatus, number> = { free: 0, paid: 0, unknown: 0 };
  for (const record of report.evaluations) {
    counts[record.evaluation.status] += 1;
  }
  return counts;
}
