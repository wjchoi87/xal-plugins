/*
 * Per-session GC statistics (#21 in INSTRUCTION.md).
 *
 * Context GC owns authoritative cumulative stats and writes them to
 * stats/<session-id>.json with atomic updates. Bytes are deterministic;
 * tokens are never estimated here. `xal-metrics` can read this file and
 * correlate with real provider usage without depending on hook ordering.
 *
 * Definitions:
 *   observedBytes  raw tool-output bytes seen by Context GC
 *   emittedBytes   bytes returned to XAL for outputs GC modified
 *   reclaimedBytes max(0, observed - emitted) for modified outputs
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile, PAGE_FILE_MODE } from "./index";

export const STATS_VERSION = 1;

export interface ContextGcStats {
  version: typeof STATS_VERSION;
  sessionId: string;
  updatedAt: number;

  /** Raw tool-output bytes seen by Context GC (all processed outputs). */
  observedBytes: number;
  /**
   * Bytes returned to XAL for outputs Context GC actually replaced
   * (PAGE / KEEP_CORE / DEDUP_REF). NOT the final model-facing context
   * size: KEEP_RAW outputs are not included here, so reading it next to
   * observedBytes would understate context usage. Kept for the stats-file
   * contract with xal-metrics; intentionally hidden from the default
   * /context-gc summary (see commands.ts).
   */
  emittedBytes: number;
  /**
   * Sum of max(0, observedBytes - emittedBytes) over modified outputs.
   * reclaimedBytes / observedBytes is the fraction of observed
   * tool-output bytes kept out of context — a byte metric, NOT a token
   * savings estimate.
   */
  reclaimedBytes: number;

  outputsObserved: number;
  outputsPaged: number;
  outputsKeptRaw: number;

  pagesCreated: number;
  duplicateHits: number;
  recalls: number;

  failOpenCount: number;
  storeFailures: number;
}

export function emptyStats(sessionId: string): ContextGcStats {
  return {
    version: STATS_VERSION,
    sessionId,
    updatedAt: Date.now(),
    observedBytes: 0,
    emittedBytes: 0,
    reclaimedBytes: 0,
    outputsObserved: 0,
    outputsPaged: 0,
    outputsKeptRaw: 0,
    pagesCreated: 0,
    duplicateHits: 0,
    recalls: 0,
    failOpenCount: 0,
    storeFailures: 0,
  };
}

export interface StatsPatch {
  observedBytes?: number;
  emittedBytes?: number;
  reclaimedBytes?: number;
  outputsObserved?: number;
  outputsPaged?: number;
  outputsKeptRaw?: number;
  pagesCreated?: number;
  duplicateHits?: number;
  recalls?: number;
  failOpenCount?: number;
  storeFailures?: number;
}

export class StatsStore {
  /** Session -> stats. Loaded lazily from disk on first touch. */
  private readonly memory = new Map<string, ContextGcStats>();

  /** Writes are serialized so concurrent sessions never interleave. */
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly statsRoot: string,
    private readonly enabled = true,
  ) {}

  statsPath(sessionId: string): string {
    return join(this.statsRoot, `${sessionId}.json`);
  }

  /** Load stats for a session from memory or disk (never throws). */
  async snapshot(sessionId: string): Promise<ContextGcStats> {
    if (!this.enabled) return emptyStats(sessionId);
    const cached = this.memory.get(sessionId);
    if (cached) return cached;
    const raw = await readFile(this.statsPath(sessionId), "utf8").catch(
      () => "",
    );
    const loaded = parseStats(raw, sessionId);
    this.memory.set(sessionId, loaded);
    return loaded;
  }

  /** Apply a numeric patch and persist. Serialized + atomic, never throws. */
  async note(sessionId: string, patch: StatsPatch): Promise<void> {
    if (!this.enabled) return;
    const stats = await this.snapshot(sessionId);
    for (const [key, delta] of Object.entries(patch) as [
      keyof StatsPatch,
      number,
    ][]) {
      if (typeof delta !== "number") continue;
      const field = key as keyof ContextGcStats;
      if (field === "sessionId" || field === "version" || field === "updatedAt")
        continue;
      stats[field] = (stats[field] as number) + delta;
    }
    stats.updatedAt = Date.now();
    const run = this.chain.then(() =>
      atomicWriteFile(
        this.statsPath(sessionId),
        `${JSON.stringify(stats, null, 2)}\n`,
        {
          mode: PAGE_FILE_MODE,
        },
      ),
    );
    this.chain = run.catch(() => undefined);
    try {
      await run;
    } catch {
      // stats write failures are never allowed to break the agent turn
    }
  }
}

function parseStats(raw: string, sessionId: string): ContextGcStats {
  if (raw.length === 0) return emptyStats(sessionId);
  try {
    const parsed = JSON.parse(raw) as Partial<ContextGcStats>;
    if (parsed.version !== STATS_VERSION) return emptyStats(sessionId);
    const base = emptyStats(sessionId);
    for (const key of Object.keys(base) as (keyof ContextGcStats)[]) {
      if (key === "version" || key === "sessionId") continue;
      const value = parsed[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        base[key] = Math.max(0, value);
      }
    }
    return base;
  } catch {
    return emptyStats(sessionId);
  }
}
