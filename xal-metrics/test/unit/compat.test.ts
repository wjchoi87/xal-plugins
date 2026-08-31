/*
 * Compatibility tests (#36, #39): plugin registration against a mock
 * PluginContext, both without stream-hook support (older XAL just ignores
 * the `stream` field) and with it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin, { metricsHook } from "../../plugin";
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

  test("legacy turn flow collects base metrics without touching stream", () => {
    const clock = fakeClock();
    const collector = new MetricsCollector({ clock });
    const hook = metricsHook(collector, undefined);
    const signal = new AbortController().signal;
    const sessionA = session();

    hook.prompt?.({ text: "hi", imageCount: 0 }, { session: sessionA, signal });
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
    expect(result).toBeUndefined();
    const ended = hook.turnEnd?.({}, { session: session(), signal });
    await expect(Promise.resolve(ended)).resolves.toBeUndefined();
  });
});

describe("stream-enabled compatibility (#37)", () => {
  test("the registered hook exercises the stream field and enhanced metrics flow", () => {
    const clock = fakeClock();
    const collector = new MetricsCollector({ clock });
    const hook = metricsHook(collector, undefined);
    const signal = new AbortController().signal;
    const sessionA = session();

    hook.prompt?.({ text: "hi", imageCount: 0 }, { session: sessionA, signal });
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
