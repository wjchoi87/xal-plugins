import { describe, expect, test } from "bun:test";
import { MetricsCollector } from "../../metrics/collector";
import { fakeClock, session } from "./helpers";

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
