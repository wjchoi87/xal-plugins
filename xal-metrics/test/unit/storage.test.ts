import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetricsCollector } from "../../metrics/collector";
import { MetricsWriter, toStoredTurn } from "../../storage/writer";
import { fakeClock, session } from "./helpers";
import type { Usage } from "../../types";

const tempDirs: string[] = [];

function collectorTurn(usage: Usage): ReturnType<MetricsCollector["finish"]> {
  const clock = fakeClock();
  const collector = new MetricsCollector({ clock });
  collector.start(session());
  clock.advance(6400);
  return collector.finish("session-a", usage);
}

function turnWithOutput(
  outputTokens: number,
): NonNullable<ReturnType<MetricsCollector["finish"]>> {
  return collectorTurn({ outputTokens })!;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "xal-metrics-storage-"));
  tempDirs.push(dir);
  return dir;
}

describe("toStoredTurn (#30)", () => {
  test("missing values are omitted, never zero", () => {
    const turn = collectorTurn({ totalInputTokens: 18_200 })!;
    const stored = JSON.parse(JSON.stringify(toStoredTurn(turn))) as Record<
      string,
      unknown
    >;
    expect(stored.inputTokens).toBe(18_200);
    expect(stored.tps).toBeUndefined();
    expect("outputTokens" in stored).toBe(false);
    expect("cacheReadTokens" in stored).toBe(false);
  });

  test("zeros and provided values are preserved", () => {
    const turn = collectorTurn({ totalInputTokens: 0, outputTokens: 138 })!;
    const stored = toStoredTurn(turn);
    expect(stored.inputTokens).toBe(0);
    expect(stored.outputTokens).toBe(138);
  });

  test("context and GC fields are persisted when present", () => {
    const clock = fakeClock();
    const collector = new MetricsCollector({ clock });
    collector.start(session(), {
      observedBytes: 1_000,
      emittedBytes: 100,
      reclaimedBytes: 900,
      outputsPaged: 1,
      duplicateHits: 0,
      recalls: 0,
      failOpenCount: 0,
    });
    const turn = collector.finish(
      "session-a",
      { totalInputTokens: 243_210, outputTokens: 1_203 },
      {
        totalInputTokens: 118_440,
        cacheReadInputTokens: 111_302,
        cacheWriteInputTokens: 4_801,
      },
      {
        observedBytes: 95_000,
        emittedBytes: 16_000,
        reclaimedBytes: 79_000,
        outputsPaged: 4,
        duplicateHits: 1,
        recalls: 1,
        failOpenCount: 1,
      },
    )!;

    const stored = toStoredTurn(turn);
    expect(stored.contextInputTokens).toBe(118_440);
    expect(stored.contextCacheReadTokens).toBe(111_302);
    expect(stored.contextCacheWriteTokens).toBe(4_801);
    expect(stored.gcObservedBytes).toBe(94_000);
    expect(stored.gcReclaimedBytes).toBe(78_100);
    expect(stored.gcPagedOutputs).toBe(3);
    expect(stored.gcRecalls).toBe(1);
    expect(stored.gcFailOpen).toBe(1);
    expect(stored.contextOutputTokens).toBeUndefined();
  });

  test("old records without new fields stay backward compatible", () => {
    const legacy = {
      sessionId: "session-a",
      provider: "anthropic",
      model: "claude-x",
      inputTokens: 18_200,
      outputTokens: 621,
      turnDurationMs: 6400,
    };
    const parsed = toStoredTurn(
      collectorTurn({ totalInputTokens: 18_200, outputTokens: 621 })!,
    );
    expect(parsed.sessionId).toBe("session-a");
    // No context/GC keys on a turn without context/GC data:
    const raw = JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>;
    expect("contextInputTokens" in raw).toBe(false);
    expect("gcObservedBytes" in raw).toBe(false);
    expect(legacy.inputTokens).toBe(18_200);
  });
});

describe("MetricsWriter (#29–32, #43)", () => {
  test("append writes one JSONL line, creating the directory", async () => {
    const dir = tempDir();
    const writer = new MetricsWriter(join(dir, "metrics", "metrics.jsonl"));
    await writer.append(collectorTurn({ outputTokens: 138 })!);

    const lines = readFileSync(join(dir, "metrics", "metrics.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(1);
    const stored = JSON.parse(lines[0]!) as {
      sessionId: string;
      turnDurationMs: number;
    };
    expect(stored.sessionId).toBe("session-a");
    expect(stored.turnDurationMs).toBe(6400);
  });

  test("no prompt, response or tool payload is stored (#33)", async () => {
    const dir = tempDir();
    const writer = new MetricsWriter(join(dir, "metrics.jsonl"));
    await writer.append(collectorTurn({ outputTokens: 138 })!);
    const content = readFileSync(join(dir, "metrics.jsonl"), "utf8");
    expect(content).not.toMatch(/"text"/);
    expect(content).not.toMatch(/"output"/);
    expect(content).not.toMatch(/"args"/);
  });

  test("retention trims the oldest lines when the size cap is exceeded (#32)", async () => {
    const dir = tempDir();
    const writer = new MetricsWriter(join(dir, "metrics.jsonl"), 300);
    for (let index = 0; index < 20; index++) {
      await writer.append(collectorTurn({ outputTokens: 138 })!);
    }
    const lines = readFileSync(join(dir, "metrics.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThan(20);
  });

  test("concurrent appends are serialized: every line lands in order", async () => {
    const dir = tempDir();
    const writer = new MetricsWriter(join(dir, "metrics.jsonl"), 240);
    const appends = Array.from({ length: 40 }, (_, index) =>
      writer.append(turnWithOutput(index)),
    );
    await Promise.all(appends);

    const lines = readFileSync(join(dir, "metrics.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const stored = JSON.parse(line) as { outputTokens?: number };
      expect(typeof stored.outputTokens).toBe("number");
    }
    // the final append is the last line, untouched by any later trim
    const last = JSON.parse(lines[lines.length - 1]!) as {
      outputTokens: number;
    };
    expect(last.outputTokens).toBe(39);
  });

  test("storage failure never throws (#43)", async () => {
    const dir = tempDir();
    const blocked = join(dir, "blocked");
    mkdirSync(blocked);
    const writer = new MetricsWriter(blocked);
    await expect(
      writer.append(collectorTurn({ outputTokens: 138 })!),
    ).resolves.toBeUndefined();
  });
});
