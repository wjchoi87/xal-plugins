import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { NormalizedOpenCodeModel, OpenCodeSource } from "./model-sources";
import { isRecord } from "./types";
import { clientRuntime } from "./runtime";
import { cacheTtlMs } from "./config";

export interface SourceModelCache {
  version: 1;
  source: OpenCodeSource;
  fetchedAt: number;
  models: NormalizedOpenCodeModel[];
}

const CACHE_VERSION = 1 as const;

/* API keys are never written to these caches — only normalized catalog
 * metadata, which is public. Cache layout follows the guide's recommended
 * `<runtime-cache>/opencode-free/{zen,go}-models.json`. */
function cacheDir(): string {
  return join(clientRuntime().paths.cache, "opencode-free");
}

function sourceCachePath(source: OpenCodeSource): string {
  return join(cacheDir(), `${source}-models.json`);
}

export async function readSourceCache(
  source: OpenCodeSource,
): Promise<SourceModelCache | undefined> {
  try {
    const raw: unknown = JSON.parse(
      await readFile(sourceCachePath(source), "utf8"),
    );
    if (!isCacheShape(raw, source)) return undefined;
    return raw as SourceModelCache;
  } catch {
    return undefined;
  }
}

function isCacheShape(value: unknown, source: OpenCodeSource): boolean {
  if (!isRecord(value)) return false;
  return (
    value.version === CACHE_VERSION &&
    value.source === source &&
    typeof value.fetchedAt === "number" &&
    Array.isArray(value.models)
  );
}

export async function writeSourceCache(
  source: OpenCodeSource,
  models: NormalizedOpenCodeModel[],
): Promise<void> {
  const path = sourceCachePath(source);
  const entry: SourceModelCache = {
    version: CACHE_VERSION,
    source,
    fetchedAt: Date.now(),
    models,
  };
  await mkdir(cacheDir(), { recursive: true });
  await writeFile(path, JSON.stringify(entry), "utf8");
}

export function isCacheFresh(cached: SourceModelCache | undefined): boolean {
  if (!cached) return false;
  return Date.now() - cached.fetchedAt < cacheTtlMs();
}

interface MergedEntry {
  id: string;
  name: string;
  contextWindow?: number;
  inputModalities: Array<"text" | "image">;
}

export interface MergedFreeCache {
  version: 1;
  fetchedAt: number;
  models: MergedEntry[];
}

const MERGED_CACHE_VERSION = 1 as const;

function mergedCachePath(): string {
  return join(cacheDir(), "merged-free-models.json");
}

export async function readMergedCache(): Promise<MergedFreeCache | undefined> {
  try {
    const raw: unknown = JSON.parse(await readFile(mergedCachePath(), "utf8"));
    if (!isRecord(raw)) return undefined;
    if (
      raw.version !== MERGED_CACHE_VERSION ||
      typeof raw.fetchedAt !== "number" ||
      !Array.isArray(raw.models)
    )
      return undefined;
    return raw as unknown as MergedFreeCache;
  } catch {
    return undefined;
  }
}

export async function writeMergedCache(entries: MergedEntry[]): Promise<void> {
  const entry: MergedFreeCache = {
    version: MERGED_CACHE_VERSION,
    fetchedAt: Date.now(),
    models: entries,
  };
  await mkdir(cacheDir(), { recursive: true });
  await writeFile(mergedCachePath(), JSON.stringify(entry), "utf8");
}
