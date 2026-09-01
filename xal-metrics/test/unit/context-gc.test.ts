/*
 * Context GC integration tests (#25): stats file reading and per-turn delta
 * computation. The reader must be fail-open — a missing/malformed file never
 * throws and simply yields no GC metrics.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContextGcMetricsReader,
  diffGc,
  estimateGcSavedTokens,
  estimateWithoutGcContext,
  type GcSnapshot,
} from "../../integrations/context-gc";

const tempDirs: string[] = [];

function statsHome(): { home: string; statsDir: string } {
  const home = mkdtempSync(join(tmpdir(), "xal-metrics-gc-"));
  tempDirs.push(home);
  const statsDir = join(home, "context-gc", "stats");
  mkdirSync(statsDir, { recursive: true });
  return { home, statsDir };
}

function writeStats(statsDir: string, sessionId: string, body: unknown): void {
  writeFileSync(join(statsDir, `${sessionId}.json`), JSON.stringify(body), {
    encoding: "utf8",
  });
}

const VALID_STATS = {
  version: 1,
  sessionId: "session-a",
  updatedAt: 1_700_000_000_000,
  observedBytes: 84_192,
  emittedBytes: 12_697,
  reclaimedBytes: 71_495,
  outputsObserved: 12,
  outputsPaged: 3,
  outputsKeptRaw: 9,
  pagesCreated: 3,
  duplicateHits: 1,
  recalls: 2,
  failOpenCount: 1,
  storeFailures: 0,
};

afterEach(() => {
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("ContextGcMetricsReader (#9, #11, #25)", () => {
  test("missing stats file yields no snapshot without error", async () => {
    const { home } = statsHome();
    const reader = new ContextGcMetricsReader(home);
    await expect(reader.read("ghost-session")).resolves.toBeUndefined();
  });

  test("valid stats file produces a snapshot", async () => {
    const { home, statsDir } = statsHome();
    writeStats(statsDir, "session-a", VALID_STATS);
    const reader = new ContextGcMetricsReader(home);

    const snapshot = await reader.read("session-a");
    expect(snapshot).toEqual({
      observedBytes: 84_192,
      emittedBytes: 12_697,
      reclaimedBytes: 71_495,
      outputsPaged: 3,
      duplicateHits: 1,
      recalls: 2,
      failOpenCount: 1,
    });
  });

  test("malformed JSON fails open", async () => {
    const { home, statsDir } = statsHome();
    writeFileSync(join(statsDir, "session-a.json"), "{not json", "utf8");
    const reader = new ContextGcMetricsReader(home);
    await expect(reader.read("session-a")).resolves.toBeUndefined();
  });

  test("stats with missing or non-numeric counters are untrusted", async () => {
    const { home, statsDir } = statsHome();
    const partial: Partial<typeof VALID_STATS> = { ...VALID_STATS };
    delete partial.observedBytes;
    writeStats(statsDir, "session-a", partial);
    const reader = new ContextGcMetricsReader(home);
    await expect(reader.read("session-a")).resolves.toBeUndefined();

    writeStats(statsDir, "session-b", { ...VALID_STATS, recalls: "x" });
    await expect(reader.read("session-b")).resolves.toBeUndefined();
  });

  test("negative counters in the stats file are rejected", async () => {
    const { home, statsDir } = statsHome();
    writeStats(statsDir, "session-a", { ...VALID_STATS, observedBytes: -1 });
    const reader = new ContextGcMetricsReader(home);
    await expect(reader.read("session-a")).resolves.toBeUndefined();
  });

  test("a read of one session never affects another", async () => {
    const { home, statsDir } = statsHome();
    writeStats(statsDir, "session-a", VALID_STATS);
    const reader = new ContextGcMetricsReader(home);
    await reader.read("session-a");
    await expect(reader.read("session-b")).resolves.toBeUndefined();
  });
});

describe("diffGc (#10, #12, #25)", () => {
  const start: GcSnapshot = {
    observedBytes: 84_192,
    emittedBytes: 12_697,
    reclaimedBytes: 71_495,
    outputsPaged: 3,
    duplicateHits: 1,
    recalls: 2,
    failOpenCount: 1,
  };

  test("valid start/end snapshots produce the delta", () => {
    const turn = diffGc(start, {
      observedBytes: 95_000,
      emittedBytes: 16_000,
      reclaimedBytes: 79_000,
      outputsPaged: 4,
      duplicateHits: 1,
      recalls: 3,
      failOpenCount: 1,
    });
    expect(turn).toEqual({
      observedBytes: 10_808,
      emittedBytes: 3_303,
      reclaimedBytes: 7_505,
      outputsPaged: 1,
      recalls: 1,
    });
  });

  test("missing either snapshot yields no delta", () => {
    expect(diffGc(undefined, start)).toBeUndefined();
    expect(diffGc(start, undefined)).toBeUndefined();
    expect(diffGc(undefined, undefined)).toBeUndefined();
  });

  test("stats reset producing a negative delta is ignored", () => {
    expect(diffGc(start, { ...start, observedBytes: 10_000 })).toBeUndefined();
    expect(diffGc(start, { ...start, failOpenCount: 0 })).toBeUndefined();
  });

  test("zero-activity turn yields no delta", () => {
    expect(diffGc(start, start)).toBeUndefined();
  });
});

describe("estimateGcSavedTokens (#14)", () => {
  test("reclaimed bytes convert at ~4 bytes per token", () => {
    expect(estimateGcSavedTokens({ gcReclaimedBytes: 4_000 })).toBe(1_000);
    expect(estimateGcSavedTokens({ gcReclaimedBytes: 32_800 })).toBe(8_200);
    // rounds below one token -> no estimate
    expect(estimateGcSavedTokens({ gcReclaimedBytes: 1 })).toBeUndefined();
    expect(estimateGcSavedTokens({})).toBeUndefined();
  });

  test("without-GC context = current context + estimated savings", () => {
    expect(
      estimateWithoutGcContext({
        contextInputTokens: 118_440,
        gcReclaimedBytes: 4_000,
      }),
    ).toBe(119_440);
    expect(
      estimateWithoutGcContext({ contextInputTokens: 118_440 }),
    ).toBeUndefined();
    expect(
      estimateWithoutGcContext({ gcReclaimedBytes: 4_000 }),
    ).toBeUndefined();
  });
});
