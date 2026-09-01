/*
 * Compatibility tests (#36, #39): plugin registration against a mock
 * PluginContext, both without stream-hook support (older XAL just ignores
 * the `stream` field) and with it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin, { metricsHook } from "../../plugin";
import { ContextGcMetricsReader } from "../../integrations/context-gc";
import { MetricsCollector } from "../../metrics/collector";
import type { Command, Hook, PluginContext } from "../../types";
import { fakeClock, session } from "./helpers";

const tempDirs: string[] = [];

function mockContext(config: Record<string, unknown> = {}): {
  ctx: PluginContext;
  hooks: Hook[];
  commands: Command[];
  home: string;
} {
  const hooks: Hook[] = [];
  const commands: Command[] = [];
  const home = mkdtempSync(join(tmpdir(), "xal-metrics-test-"));
  tempDirs.push(home);
  const ctx: PluginContext = {
    config,
    runtime: { paths: { home, cache: join(home, "cache") } },
    registerHook: (hook) => {
      hooks.push(hook);
    },
    registerCommand: (command) => {
      commands.push(command);
    },
  };
  return { ctx, hooks, commands, home };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("legacy compatibility (#36)", () => {
  test("plugin register succeeds on every event shape and registers hook + command", () => {
    const { ctx, hooks, commands } = mockContext();
    plugin.register(ctx);

    expect(hooks).toHaveLength(1);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.name).toBe("metrics");
    const hook = hooks[0]!;
    expect(typeof hook.prompt).toBe("function");
    expect(typeof hook.beforeTool).toBe("function");
    expect(typeof hook.afterTool).toBe("function");
    expect(typeof hook.turnEnd).toBe("function");
    // the stream field is present but harmless on runtimes that ignore it
    expect(typeof hook.stream).toBe("function");
  });

  test("legacy turn flow collects base metrics without touching stream", async () => {
    const clock = fakeClock();
    const collector = new MetricsCollector({ clock });
    const hook = metricsHook(collector, undefined);
    const signal = new AbortController().signal;
    const sessionA = session();

    await hook.prompt?.(
      { text: "hi", imageCount: 0 },
      { session: sessionA, signal },
    );
    clock.advance(6400);
    const completed = collector.finish("session-a", {
      totalInputTokens: 18_200,
      outputTokens: 621,
    });

    expect(completed).toBeDefined();
    expect(completed!.totalInputTokens).toBe(18_200);
    expect(completed!.firstTextAt).toBeUndefined();
    expect(collector.history()).toHaveLength(1);
  });

  test("a throwing collector never breaks the agent turn (#43)", async () => {
    const failing = {
      start: () => {
        throw new Error("boom");
      },
      beginTool: () => undefined,
      endTool: () => undefined,
      stream: () => undefined,
      finish: () => {
        throw new Error("boom");
      },
      history: () => [],
      lastTurn: () => undefined,
    } as unknown as MetricsCollector;

    const hook = metricsHook(failing, undefined);
    const signal = new AbortController().signal;
    const result = hook.prompt?.(
      { text: "hi", imageCount: 0 },
      { session: session(), signal },
    );
    await expect(Promise.resolve(result)).resolves.toBeUndefined();
    const ended = hook.turnEnd?.({}, { session: session(), signal });
    await expect(Promise.resolve(ended)).resolves.toBeUndefined();
  });
});

describe("stream-enabled compatibility (#37)", () => {
  test("the registered hook exercises the stream field and enhanced metrics flow", async () => {
    const clock = fakeClock();
    const collector = new MetricsCollector({ clock });
    const hook = metricsHook(collector, undefined);
    const signal = new AbortController().signal;
    const sessionA = session();

    await hook.prompt?.(
      { text: "hi", imageCount: 0 },
      { session: sessionA, signal },
    );
    clock.advance(1300);
    hook.stream?.(
      { event: { type: "text_delta", text: "x" } },
      { session: sessionA, signal },
    );
    clock.advance(8577);
    hook.stream?.({ event: { type: "done" } }, { session: sessionA, signal });
    const completed = collector.finish("session-a", {
      outputTokens: 621,
      totalInputTokens: 18_200,
    });

    expect(completed).toBeDefined();
    expect(completed!.firstTextAt).toBe(1300);
    expect(completed!.generationMs).toBe(8577);
  });
});

describe("Context GC integration through hooks (#26, #25)", () => {
  const statsFor = (overrides: Record<string, unknown> = {}) => ({
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
    recalls: 1,
    failOpenCount: 0,
    storeFailures: 0,
    ...overrides,
  });

  test("no stats file -> turn completes without error and without GC metrics", async () => {
    const { home } = mockContext();
    const clock = fakeClock();
    const collector = new MetricsCollector({ clock });
    const hook = metricsHook(
      collector,
      undefined,
      new ContextGcMetricsReader(home),
    );
    const signal = new AbortController().signal;
    const sessionA = session();

    await hook.prompt?.(
      { text: "hi", imageCount: 0 },
      { session: sessionA, signal },
    );
    clock.advance(6400);
    await hook.turnEnd?.(
      { usage: { totalInputTokens: 100 }, context: {} },
      { session: sessionA, signal },
    );

    const turn = collector.lastTurn("session-a");
    expect(turn!.totalInputTokens).toBe(100);
    expect(turn!.gcObservedBytes).toBeUndefined();
  });

  test("GC metrics derive from stats snapshots only, never from hook ordering", async () => {
    const { home } = mockContext();
    const statsDir = join(home, "context-gc", "stats");
    mkdirSync(statsDir, { recursive: true });
    const statsPath = join(statsDir, "session-a.json");

    // Whether xal-context-gc's afterTool ran before or after metrics, the
    // metrics result is the stats snapshot delta — metrics never reads
    // afterTool output to infer Context GC savings (#26).
    writeFileSync(statsPath, JSON.stringify(statsFor()), "utf8");

    const clock = fakeClock();
    const collector = new MetricsCollector({ clock });
    const hook = metricsHook(
      collector,
      undefined,
      new ContextGcMetricsReader(home),
    );
    const signal = new AbortController().signal;
    const sessionA = session();

    await hook.prompt?.(
      { text: "hi", imageCount: 0 },
      { session: sessionA, signal },
    );
    clock.advance(6400);
    writeFileSync(
      statsPath,
      JSON.stringify(
        statsFor({
          observedBytes: 95_000,
          emittedBytes: 16_000,
          reclaimedBytes: 79_000,
          outputsPaged: 4,
          recalls: 2,
        }),
      ),
      "utf8",
    );
    await hook.turnEnd?.(
      {
        usage: { totalInputTokens: 243_210 },
        context: { totalInputTokens: 118_440 },
      },
      { session: sessionA, signal },
    );

    const turn = collector.lastTurn("session-a");
    expect(turn!.totalInputTokens).toBe(243_210);
    expect(turn!.contextInputTokens).toBe(118_440);
    expect(turn!.gcObservedBytes).toBe(10_808);
    expect(turn!.gcEmittedBytes).toBe(3_303);
    expect(turn!.gcReclaimedBytes).toBe(7_505);
    expect(turn!.gcPagedOutputs).toBe(1);
    expect(turn!.gcRecalls).toBe(1);
  });

  test("malformed stats never fail the agent turn", async () => {
    const { home } = mockContext();
    const statsDir = join(home, "context-gc", "stats");
    mkdirSync(statsDir, { recursive: true });
    writeFileSync(join(statsDir, "session-a.json"), "{bad json", "utf8");

    const clock = fakeClock();
    const collector = new MetricsCollector({ clock });
    const hook = metricsHook(
      collector,
      undefined,
      new ContextGcMetricsReader(home),
    );
    const signal = new AbortController().signal;
    const sessionA = session();

    await hook.prompt?.(
      { text: "hi", imageCount: 0 },
      { session: sessionA, signal },
    );
    clock.advance(100);
    await hook.turnEnd?.(
      { usage: { totalInputTokens: 50 } },
      { session: sessionA, signal },
    );

    const turn = collector.lastTurn("session-a");
    expect(turn!.totalInputTokens).toBe(50);
    expect(turn!.gcObservedBytes).toBeUndefined();
  });

  test("turns in separate sessions use separate stats files", async () => {
    const { home } = mockContext();
    const statsDir = join(home, "context-gc", "stats");
    mkdirSync(statsDir, { recursive: true });
    writeFileSync(
      join(statsDir, "session-a.json"),
      JSON.stringify(statsFor()),
      "utf8",
    );
    writeFileSync(
      join(statsDir, "session-b.json"),
      JSON.stringify(
        statsFor({
          observedBytes: 5_000,
          emittedBytes: 500,
          reclaimedBytes: 4_500,
        }),
      ),
      "utf8",
    );

    const clock = fakeClock();
    const collector = new MetricsCollector({ clock });
    const hook = metricsHook(
      collector,
      undefined,
      new ContextGcMetricsReader(home),
    );
    const signal = new AbortController().signal;

    await hook.prompt?.(
      { text: "hi", imageCount: 0 },
      { session: session("session-a"), signal },
    );
    await hook.prompt?.(
      { text: "hi", imageCount: 0 },
      {
        session: session("session-b", { kind: "subagent" }),
        signal,
      },
    );
    writeFileSync(
      join(statsDir, "session-a.json"),
      JSON.stringify(statsFor({ observedBytes: 95_000 })),
      "utf8",
    );
    writeFileSync(
      join(statsDir, "session-b.json"),
      JSON.stringify(
        statsFor({
          observedBytes: 9_000,
          emittedBytes: 900,
          reclaimedBytes: 8_100,
        }),
      ),
      "utf8",
    );
    await hook.turnEnd?.({}, { session: session("session-a"), signal });
    await hook.turnEnd?.(
      {},
      { session: session("session-b", { kind: "subagent" }), signal },
    );

    const turnA = collector.lastTurn("session-a");
    const turnB = collector.lastTurn("session-b");
    expect(turnA!.gcObservedBytes).toBe(10_808);
    expect(turnB!.gcObservedBytes).toBe(4_000);
  });
});
