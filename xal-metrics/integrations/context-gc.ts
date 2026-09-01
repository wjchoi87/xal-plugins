/*
 * Context GC integration (#9–12).
 *
 * xal-context-gc owns authoritative cumulative per-session stats at:
 *
 *   <runtime.paths.home>/context-gc/stats/<session-id>.json
 *
 * The integration contract is the JSON stats schema only — this module never
 * imports source code from xal-context-gc, so both plugins stay independently
 * installable and metrics never depends on plugin hook ordering.
 *
 * Metrics reads the stats file twice per turn (prompt start, turnEnd) and
 * diffs the cumulative counters. Because the stats are cumulative, turn deltas
 * are independent of whether xal-context-gc's afterTool hook ran before or
 * after the metrics hook.
 *
 * Fail-open policy: a missing file, malformed JSON, or an invalid/negative
 * delta simply yields no GC metrics — it never throws into the agent turn.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface GcSnapshot {
  observedBytes: number;
  emittedBytes: number;
  reclaimedBytes: number;
  outputsPaged: number;
  duplicateHits: number;
  recalls: number;
  failOpenCount: number;
}

export interface TurnGcMetrics {
  observedBytes?: number;
  emittedBytes?: number;
  reclaimedBytes?: number;
  outputsPaged?: number;
  duplicateHits?: number;
  recalls?: number;
  failOpen?: number;
}

/** Stats schema written by xal-context-gc (contract, not imported). */
interface ContextGcStatsFile {
  version: number;
  sessionId: string;
  updatedAt: number;
  observedBytes: number;
  emittedBytes: number;
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

const SNAPSHOT_FIELDS: (keyof GcSnapshot)[] = [
  "observedBytes",
  "emittedBytes",
  "reclaimedBytes",
  "outputsPaged",
  "duplicateHits",
  "recalls",
  "failOpenCount",
];

/**
 * Every snapshot field must be a non-negative number, otherwise the snapshot
 * is treated as absent (malformed/unrecognized stats are never trusted).
 */
function normalizeSnapshot(raw: unknown): GcSnapshot | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const value = raw as Partial<ContextGcStatsFile>;
  for (const field of SNAPSHOT_FIELDS) {
    const entry = value[field];
    if (typeof entry !== "number" || !Number.isFinite(entry) || entry < 0)
      return undefined;
  }
  return {
    observedBytes: value.observedBytes as number,
    emittedBytes: value.emittedBytes as number,
    reclaimedBytes: value.reclaimedBytes as number,
    outputsPaged: value.outputsPaged as number,
    duplicateHits: value.duplicateHits as number,
    recalls: value.recalls as number,
    failOpenCount: value.failOpenCount as number,
  };
}

export class ContextGcMetricsReader {
  private readonly root: string;

  constructor(home: string) {
    this.root = join(home, "context-gc", "stats");
  }

  /**
   * Returns the current cumulative GC snapshot for a session, or undefined
   * when Context GC is absent, the file is missing, or it cannot be parsed.
   * All I/O and parse errors are swallowed (#11, #25).
   */
  async read(sessionId: string): Promise<GcSnapshot | undefined> {
    const content = await readFile(
      join(this.root, `${sessionId}.json`),
      "utf8",
    ).catch(() => undefined);
    if (content === undefined) return undefined;
    try {
      return normalizeSnapshot(JSON.parse(content));
    } catch {
      return undefined;
    }
  }
}

/**
 * Per-turn delta between two cumulative snapshots. When any counter went
 * backwards (stats reset, file recreated) the whole turn's GC metrics are
 * ignored: never emit a partial or negative delta. Zero deltas are treated as
 * no activity and omitted, so a turn where GC did nothing stays clean.
 */
export function diffGc(
  start: GcSnapshot | undefined,
  end: GcSnapshot | undefined,
): TurnGcMetrics | undefined {
  if (start === undefined || end === undefined) return undefined;

  const raw: TurnGcMetrics = {
    observedBytes: end.observedBytes - start.observedBytes,
    emittedBytes: end.emittedBytes - start.emittedBytes,
    reclaimedBytes: end.reclaimedBytes - start.reclaimedBytes,
    outputsPaged: end.outputsPaged - start.outputsPaged,
    duplicateHits: end.duplicateHits - start.duplicateHits,
    recalls: end.recalls - start.recalls,
    failOpen: end.failOpenCount - start.failOpenCount,
  };

  const invalid = Object.values(raw).some(
    (value) => value !== undefined && value < 0,
  );
  if (invalid) return undefined;

  const turn: TurnGcMetrics = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== undefined && value > 0)
      turn[key as keyof TurnGcMetrics] = value;
  }
  return Object.keys(turn).length > 0 ? turn : undefined;
}

/**
 * Rough bytes → tokens conversion for showing Context GC savings in the UI.
 * This is an ESTIMATE (~4 bytes per token), never an exact token count —
 * every surfaced value keeps a "~" prefix to make that explicit.
 */
export const BYTES_PER_TOKEN = 4;

/** Estimated context tokens reclaimed by Context GC this turn. */
export function estimateGcSavedTokens(turn: {
  gcReclaimedBytes?: number;
}): number | undefined {
  if (turn.gcReclaimedBytes === undefined) return undefined;
  const tokens = Math.round(turn.gcReclaimedBytes / BYTES_PER_TOKEN);
  return tokens > 0 ? tokens : undefined;
}

/**
 * Estimated context footprint had Context GC not paged anything:
 * current context tokens + estimated GC-reclaimed tokens.
 */
export function estimateWithoutGcContext(turn: {
  contextInputTokens?: number;
  gcReclaimedBytes?: number;
}): number | undefined {
  if (turn.contextInputTokens === undefined) return undefined;
  const saved = estimateGcSavedTokens(turn);
  if (saved === undefined) return undefined;
  return turn.contextInputTokens + saved;
}
