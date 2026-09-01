import { describe, expect, test } from "bun:test";
import { MetricsCollector } from "../../metrics/collector";
import type { GcSnapshot } from "../../integrations/context-gc";
import { fakeClock, session } from "./helpers";

const gc = (overrides: Partial<GcSnapshot> = {}): GcSnapshot => ({
  observedBytes: 84_192,
  emittedBytes: 12_697,
  reclaimedBytes: 71_495,
  outputsPaged: 3,
  duplicateHits: 1,
  recalls: 1,
  failOpenCount: 0,
  ...overrides,
});

describe("MetricsCollector legacy flow", () => {
  test("start -> finish records turn duration and usage", () => {
    const clock = fakeClock();
    const collector = new MetricsCollector({ clock });
    collector.start(session());
    clock.advance(6400);
    const completed = collector.finish("session-a", {
      totalInputTokens: 4300,
      outputTokens: 138,
    });

    expect(completed).toBeDefined();
    expect(completed!.startedAt).toBe(0);
    expect(completed!.completedAt).toBe(6400);
    expect(completed!.totalInputTokens).toBe(4300);
    expect(completed!.outputTokens).toBe(138);
    expect(collector.history()).toHaveLength(1);
  });

  test("undefined usage fields stay undefined, zero is preserved (#8, #20)", () => {
    const collector = new MetricsCollector({ clock: fakeClock() });
    collector.start(session());
    const zero = collector.finish("session-a", {
      totalInputTokens: 0,
      outputTokens: 0,
    });
    expect(zero!.totalInputTokens).toBe(0);
    expect(zero!.outputTokens).toBe(0);

    collector.start(session());
    const missing = collector.finish("session-a", {});
    expect(missing!.totalInputTokens).toBeUndefined();
    expect(missing!.outputTokens).toBeUndefined();
  });

  test("multiple turns in one session do not mix", () => {
    const clock = fakeClock();
    const collector = new MetricsCollector({ clock });
    collector.start(session());
    clock.advance(1000);
    collector.finish("session-a", { totalInputTokens: 10 });
    collector.start(session());
    clock.advance(2000);
    collector.finish("session-a", { outputTokens: 20 });

    expect(collector.history()).toHaveLength(2);
    const [first, second] = collector.history();
    expect(first!.totalInputTokens).toBe(10);
    expect(first!.outputTokens).toBeUndefined();
    expect(second!.totalInputTokens).toBeUndefined();
    expect(second!.outputTokens).toBe(20);
    const last = collector.lastTurn("session-a");
    expect(last).toBe(second);
  });

  test("a repeated prompt discards the unfinished turn", () => {
    const clock = fakeClock();
    const collector = new MetricsCollector({ clock });
    collector.start(session());
    clock.advance(500);
    collector.start(session());
    clock.advance(500);
    collector.finish("session-a", { outputTokens: 1 });

    expect(collector.history()).toHaveLength(1);
    expect(collector.history()[0]!.startedAt).toBe(500);
  });

  test("finish without a started turn returns undefined", () => {
    const collector = new MetricsCollector({ clock: fakeClock() });
    expect(collector.finish("ghost", {})).toBeUndefined();
  });
});

describe("MetricsCollector tool timing (#7)", () => {
  test("beforeTool -> afterTool accumulates duration per tool", () => {
    const clock = fakeClock();
    const collector = new MetricsCollector({ clock });
    collector.start(session());

    collector.beginTool("session-a", "call-1", "bash");
    clock.advance(1200);
    collector.endTool("session-a", "call-1");

    collector.beginTool("session-a", "call-2", "read");
    clock.advance(600);
    collector.endTool("session-a", "call-2");

    collector.beginTool("session-a", "call-3", "bash");
    clock.advance(300);
    collector.endTool("session-a", "call-3");

    const completed = collector.finish("session-a", {});
    expect(completed!.toolCount).toBe(3);
    expect(completed!.toolDurationMs).toBe(2100);
    expect(completed!.toolStats).toEqual([
      { tool: "bash", count: 2, totalMs: 1500, maxMs: 1200 },
      { tool: "read", count: 1, totalMs: 600, maxMs: 600 },
    ]);
  });

  test("tool events without an active turn are ignored", () => {
    const collector = new MetricsCollector({ clock: fakeClock() });
    collector.beginTool("ghost", "call-1", "bash");
    expect(collector.endTool("ghost", "call-1")).toBeUndefined();
  });
});

describe("MetricsCollector concurrent sessions (#39)", () => {
  test("two sessions keep their state separate", () => {
    const clock = fakeClock();
    const collector = new MetricsCollector({ clock });
    collector.start(session("primary"));
    collector.start(session("sub", { kind: "subagent" }));

    clock.advance(100);
    collector.beginTool("sub", "call-1", "bash");
    clock.advance(900);
    collector.endTool("sub", "call-1");

    clock.advance(200);
    const primaryDone = collector.finish("primary", { outputTokens: 5 });
    clock.advance(300);
    const subDone = collector.finish("sub", { outputTokens: 9 });

    expect(primaryDone!.toolCount).toBe(0);
    expect(primaryDone!.completedAt).toBe(1200);
    expect(subDone!.toolCount).toBe(1);
    expect(subDone!.toolDurationMs).toBe(900);
    expect(subDone!.completedAt).toBe(1500);
    expect(collector.history()).toHaveLength(2);
  });
});

describe("MetricsCollector context usage (#3, #4)", () => {
  test("stores turnEnd.context separately from turnEnd.usage", () => {
    const collector = new MetricsCollector({ clock: fakeClock() });
    collector.start(session());
    const completed = collector.finish(
      "session-a",
      { totalInputTokens: 243_210, cacheReadInputTokens: 215_420 },
      { totalInputTokens: 118_440, cacheReadInputTokens: 111_302 },
    );

    expect(completed!.totalInputTokens).toBe(243_210);
    expect(completed!.cacheReadTokens).toBe(215_420);
    expect(completed!.contextInputTokens).toBe(118_440);
    expect(completed!.contextCacheReadTokens).toBe(111_302);
  });

  test("turn usage and context usage are never mixed", () => {
    const collector = new MetricsCollector({ clock: fakeClock() });
    collector.start(session());
    const completed = collector.finish(
      "session-a",
      { outputTokens: 1_203 },
      { totalInputTokens: 10 },
    );

    expect(completed!.outputTokens).toBe(1_203);
    expect(completed!.contextOutputTokens).toBeUndefined();
    expect(completed!.totalInputTokens).toBeUndefined();
    expect(completed!.contextInputTokens).toBe(10);
  });

  test("missing context keeps context fields absent", () => {
    const collector = new MetricsCollector({ clock: fakeClock() });
    collector.start(session());
    const completed = collector.finish("session-a", { totalInputTokens: 5 });
    expect(completed!.contextInputTokens).toBeUndefined();
  });
});

describe("MetricsCollector Context GC deltas (#10, #12, #25)", () => {
  test("start/end snapshots produce a per-turn delta", () => {
    const clock = fakeClock();
    const collector = new MetricsCollector({ clock });
    collector.start(session(), gc());
    clock.advance(1000);
    const completed = collector.finish(
      "session-a",
      { totalInputTokens: 100 },
      undefined,
      gc({
        observedBytes: 95_000,
        emittedBytes: 16_000,
        reclaimedBytes: 79_000,
        outputsPaged: 4,
        duplicateHits: 1,
        recalls: 2,
        failOpenCount: 0,
      }),
    );

    expect(completed!.gcObservedBytes).toBe(10_808);
    expect(completed!.gcEmittedBytes).toBe(3_303);
    expect(completed!.gcReclaimedBytes).toBe(7_505);
    expect(completed!.gcPagedOutputs).toBe(1);
    expect(completed!.gcDedupHits).toBeUndefined(); // zero delta is no activity
    expect(completed!.gcRecalls).toBe(1);
    expect(completed!.gcFailOpen).toBeUndefined();
  });

  test("no GC snapshots -> no GC metrics at all", () => {
    const collector = new MetricsCollector({ clock: fakeClock() });
    collector.start(session());
    const completed = collector.finish("session-a", {});
    expect(completed!.gcObservedBytes).toBeUndefined();
    expect(completed!.gcReclaimedBytes).toBeUndefined();
  });

  test("stats reset causing negative delta is ignored for that turn", () => {
    const collector = new MetricsCollector({ clock: fakeClock() });
    collector.start(session(), gc({ observedBytes: 100_000 }));
    const completed = collector.finish(
      "session-a",
      {},
      undefined,
      gc({ observedBytes: 50_000 }),
    );
    expect(completed!.gcObservedBytes).toBeUndefined();
    expect(completed!.gcRecalls).toBeUndefined();
  });

  test("zero-activity turn stays clean", () => {
    const collector = new MetricsCollector({ clock: fakeClock() });
    collector.start(session(), gc());
    const completed = collector.finish("session-a", {}, undefined, gc());
    expect(completed!.gcObservedBytes).toBeUndefined();
  });

  test("interleaved sessions use separate GC snapshots", () => {
    const collector = new MetricsCollector({ clock: fakeClock() });
    collector.start(session("primary"), gc());
    collector.start(
      session("sub", { kind: "subagent" }),
      gc({ observedBytes: 1000, emittedBytes: 100, reclaimedBytes: 900 }),
    );

    const primaryDone = collector.finish(
      "primary",
      {},
      undefined,
      gc({ observedBytes: 95_000 }),
    );
    const subDone = collector.finish(
      "sub",
      {},
      undefined,
      gc({ observedBytes: 5000, emittedBytes: 500, reclaimedBytes: 4500 }),
    );

    expect(primaryDone!.gcObservedBytes).toBe(10_808);
    expect(subDone!.gcObservedBytes).toBe(4_000);
  });
});
