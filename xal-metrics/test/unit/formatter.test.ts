import { describe, expect, test } from "bun:test";
import { formatDuration, formatTokens, formatTps } from "../../lib/format";
import { MetricsCollector } from "../../metrics/collector";
import { formatCompact, formatDetail } from "../../metrics/formatter";
import { fakeClock, session } from "./helpers";
import type { GcSnapshot } from "../../integrations/context-gc";
import type { StreamEvent, Usage } from "../../types";

const text = (): StreamEvent => ({ type: "text_delta", text: "x" });
const done = (): StreamEvent => ({ type: "done" });

const gc = (overrides: Partial<GcSnapshot> = {}): GcSnapshot => ({
  observedBytes: 1_000,
  emittedBytes: 100,
  reclaimedBytes: 900,
  outputsPaged: 1,
  duplicateHits: 0,
  recalls: 0,
  failOpenCount: 0,
  ...overrides,
});

function legacyTurn(
  tokens?: { input: number; output: number },
  wallElapsedMs = 6400,
) {
  const clock = fakeClock();
  const collector = new MetricsCollector({ clock });
  collector.start(session());
  clock.advance(wallElapsedMs);
  return collector.finish(
    "session-a",
    tokens
      ? { totalInputTokens: tokens.input, outputTokens: tokens.output }
      : {},
  )!;
}

function streamedTurn(opts: {
  reasoningAt?: number;
  textAt: number;
  doneAt: number;
  output?: number;
}) {
  const clock = fakeClock();
  const collector = new MetricsCollector({ clock });
  collector.start(session());
  if (opts.reasoningAt !== undefined) {
    clock.advance(opts.reasoningAt);
    collector.stream("session-a", { type: "reasoning_delta", text: "x" });
  }
  clock.advance(opts.textAt - (opts.reasoningAt ?? 0));
  collector.stream("session-a", text());
  clock.advance(opts.doneAt - opts.textAt);
  collector.stream("session-a", done());
  return collector.finish(
    "session-a",
    opts.output !== undefined ? { outputTokens: opts.output } : {},
  )!;
}

describe("compact formatter (#21–24, #50)", () => {
  test("legacy example: 6.4s · in 18.2K · out 621", () => {
    const turn = legacyTurn({ input: 18_200, output: 621 });
    expect(formatCompact(turn)).toBe("6.4s · in 18.2K · out 621");
  });

  test("legacy + cache example", () => {
    const turn = legacyTurn({ input: 18_200, output: 621 });
    turn.cacheReadTokens = 16_744;
    expect(formatCompact(turn)).toBe("6.4s · in 18.2K · out 621 · cache 92%");
  });

  test("stream example: TPS and TTFT come first", () => {
    const turn = streamedTurn({
      textAt: 1300,
      doneAt: 1300 + 8577,
      output: 621,
    });
    turn.totalInputTokens = 18_200;
    expect(formatCompact(turn)).toBe(
      `TPS 72.4 · TTFT 1.3s · ${formatDuration(9877)} · in 18.2K · out 621`,
    );
  });

  test("stall example: max stall × count", () => {
    const turn = streamedTurn({ textAt: 0, doneAt: 100, output: 621 });
    turn.stalls.push(2100, 2700);
    expect(formatCompact(turn)).toContain("stall 2.7s×2");
  });

  test("no cache -> no cache segment", () => {
    const turn = legacyTurn({ input: 18_200, output: 621 });
    expect(formatCompact(turn)).not.toContain("cache");
  });

  test("no stall -> no stall segment", () => {
    const turn = streamedTurn({ textAt: 0, doneAt: 100, output: 10 });
    expect(formatCompact(turn)).not.toContain("stall");
  });

  test("cacheWrite alone is not shown (#10)", () => {
    const turn = legacyTurn({ input: 100, output: 10 });
    turn.cacheWriteTokens = 500;
    expect(formatCompact(turn)).not.toContain("cache");
  });

  test("tools stay out of the compact line (#23)", () => {
    const clock = fakeClock();
    const collector = new MetricsCollector({ clock });
    collector.start(session());
    collector.beginTool("session-a", "call-1", "bash");
    clock.advance(1200);
    collector.endTool("session-a", "call-1");
    clock.advance(100);
    const turn = collector.finish("session-a", {})!;
    expect(formatCompact(turn)).toBe("1.3s");
    expect(formatCompact(turn)).not.toContain("tool");
  });

  test("turn duration alone is always shown (#21)", () => {
    const clock = fakeClock();
    const collector = new MetricsCollector({ clock });
    collector.start(session());
    clock.advance(100);
    const turn = collector.finish("session-a", {})!;
    expect(formatCompact(turn)).toBe("100ms");
  });

  test("zero tokens are hidden while turn duration stays", () => {
    const turn = legacyTurn({ input: 0, output: 0 });
    turn.totalInputTokens = 0;
    turn.outputTokens = 0;
    expect(formatCompact(turn)).toBe("6.4s");
  });
});

describe("number formatting (#24)", () => {
  test("tokens", () => {
    expect(formatTokens(621)).toBe("621");
    expect(formatTokens(4300)).toBe("4.3K");
    expect(formatTokens(63_000)).toBe("63K");
    expect(formatTokens(18_200)).toBe("18.2K");
    expect(formatTokens(1_200_000)).toBe("1.2M");
  });

  test("durations", () => {
    expect(formatDuration(820)).toBe("820ms");
    expect(formatDuration(1300)).toBe("1.3s");
    expect(formatDuration(6400)).toBe("6.4s");
    expect(formatDuration(95_000)).toBe("1m 35s");
  });

  test("tps", () => {
    expect(formatTps(72.428392)).toBe("72.4");
    expect(formatTps(621)).toBe("621");
    expect(formatTps(100.4)).toBe("100");
  });
});

function fullTurn(opts: {
  usage?: Usage;
  context?: Usage;
  gcStart?: GcSnapshot;
  gcEnd?: GcSnapshot;
}): NonNullable<ReturnType<MetricsCollector["finish"]>> {
  const clock = fakeClock();
  const collector = new MetricsCollector({ clock });
  collector.start(session(), opts.gcStart);
  clock.advance(6400);
  return collector.finish("session-a", opts.usage, opts.context, opts.gcEnd)!;
}

describe("compact formatter ctx (#6, #24)", () => {
  test("ctx uses contextInputTokens, distinct from turn input", () => {
    const turn = fullTurn({
      usage: { totalInputTokens: 243_210, outputTokens: 1_203 },
      context: { totalInputTokens: 118_440 },
    });
    expect(formatCompact(turn)).toBe("6.4s · ctx 118K · in 243K · out 1.2K");
  });

  test("ctx is omitted when context is unavailable", () => {
    const turn = fullTurn({
      usage: { totalInputTokens: 18_200, outputTokens: 621 },
    });
    expect(formatCompact(turn)).toBe("6.4s · in 18.2K · out 621");
  });

  test("ctx appears before in/out and after duration", () => {
    const turn = fullTurn({
      usage: { totalInputTokens: 243_210, outputTokens: 1_203 },
      context: { totalInputTokens: 118_440 },
    });
    const compact = formatCompact(turn)!;
    expect(compact.indexOf("ctx")).toBeLessThan(compact.indexOf("in"));
    expect(compact.indexOf("dur")).toBe(-1); // duration is the bare "6.4s"
  });
});

describe("compact formatter GC savings (#13)", () => {
  test("gc shows estimated reclaimed tokens when > 0", () => {
    const turn = fullTurn({
      usage: { totalInputTokens: 243_210, outputTokens: 1_203 },
      context: { totalInputTokens: 118_440 },
      gcStart: gc(),
      gcEnd: gc({ reclaimedBytes: 1_800 }), // delta 900 bytes -> ~225 tokens
    });
    const compact = formatCompact(turn)!;
    expect(compact).toContain("ctx 118K");
    expect(compact).toContain("in 243K");
    expect(compact).toContain("gc ~225");
  });

  test("gc is hidden when nothing was reclaimed", () => {
    const turn = fullTurn({
      usage: { totalInputTokens: 10 },
      context: { totalInputTokens: 8 },
    });
    expect(formatCompact(turn)).not.toContain("gc");
  });
});

describe("detail formatter cache labelling (#19, #23)", () => {
  test("detail says Cache cov, never Cache hit", () => {
    const turn = fullTurn({
      usage: {
        totalInputTokens: 18_284,
        cacheReadInputTokens: 16_902,
        cacheWriteInputTokens: 1_000,
        outputTokens: 138,
      },
    });
    const lines = formatDetail(turn!, 1);
    expect(lines.some((line) => line.includes("Cache cov"))).toBe(true);
    expect(lines.some((line) => line.includes("Cache hit"))).toBe(false);
  });

  test("old metrics record without cache still formats (#23)", () => {
    const turn = fullTurn({ usage: { totalInputTokens: 5_000 } });
    const lines = formatDetail(turn!, 1);
    expect(lines.join("\n")).toContain("Turn usage");
    expect(lines.join("\n")).toContain("Input");
    expect(lines.some((line) => line.includes("Cache read"))).toBe(false);
    expect(lines.some((line) => line.includes("Cache cov"))).toBe(false);
  });
});

describe("detail formatter sections (#6, #24, #29)", () => {
  test("turn usage and context sections render separately", () => {
    const turn = fullTurn({
      usage: {
        totalInputTokens: 243_210,
        outputTokens: 1_203,
        cacheReadInputTokens: 215_420,
        cacheWriteInputTokens: 22_310,
      },
      context: {
        totalInputTokens: 118_440,
        cacheReadInputTokens: 111_302,
        cacheWriteInputTokens: 4_801,
      },
    });
    const lines = formatDetail(turn!, 1).join("\n");
    expect(lines).toContain("Turn usage");
    expect(lines).toContain("Context");
    expect(lines).toContain("  Cache read   215,420");
    expect(lines).toContain("  Cache cov    88.6%");
    expect(lines).toContain("  Cache read   111,302");
    expect(lines).toContain("  Cache cov    94.0%");
    expect(lines).toContain("\n  Input");
    expect(lines).toContain("118,440");
  });

  test("context section is omitted entirely when unavailable", () => {
    const turn = fullTurn({ usage: { totalInputTokens: 10 } });
    const lines = formatDetail(turn!, 1);
    expect(lines.includes("Context")).toBe(false);
    expect(lines.includes("Context GC")).toBe(false);
  });

  test("compact ctx does not leak into detail context section", () => {
    const turn = fullTurn({
      usage: { totalInputTokens: 10_000, outputTokens: 100 },
      context: { totalInputTokens: 7_000 },
    });
    const lines = formatDetail(turn!, 1);
    expect(lines.includes("Context")).toBe(true);
    expect(lines.includes("Turn usage")).toBe(true);
  });
});

describe("detail formatter Context GC section (#14, #25)", () => {
  test("renders estimated token savings and counters", () => {
    const turn = fullTurn({
      context: { totalInputTokens: 118_440 },
      gcStart: gc(),
      gcEnd: gc({
        observedBytes: 2_000,
        emittedBytes: 200,
        reclaimedBytes: 1_800, // delta 900 bytes -> ~225 tokens
        outputsPaged: 2,
        recalls: 1,
      }),
    });
    const lines = formatDetail(turn!, 1);
    expect(lines.includes("Context GC")).toBe(true);
    expect(lines.some((line) => line.includes("GC saved"))).toBe(true);
    expect(lines.some((line) => line.includes("~225"))).toBe(true);
    expect(lines.some((line) => line.includes("Without GC"))).toBe(true);
    expect(lines.some((line) => line.includes("Paged"))).toBe(true);
    expect(lines.some((line) => line.includes("Recalls"))).toBe(true);
    expect(lines.some((line) => line.includes("Fail-open"))).toBe(false);
  });

  test("exact byte figures are not shown in the UI", () => {
    const turn = fullTurn({
      gcStart: gc(),
      gcEnd: gc({ reclaimedBytes: 1_800 }),
    });
    const lines = formatDetail(turn!, 1);
    expect(lines.some((line) => line.includes("Observed"))).toBe(false);
    expect(lines.some((line) => line.includes("Emitted"))).toBe(false);
    expect(lines.some((line) => line.includes("KB"))).toBe(false);
  });

  test("without-GC context adds estimated savings to current context", () => {
    const turn = fullTurn({
      usage: { totalInputTokens: 243_210, outputTokens: 1_203 },
      context: { totalInputTokens: 118_440 },
      gcStart: gc(),
      gcEnd: gc({ reclaimedBytes: 1_800 }), // ~225 tokens saved
    });
    const lines = formatDetail(turn!, 1);
    expect(lines.some((line) => line.includes("~118,665"))).toBe(true);
  });

  test("fail-open appears only when > 0", () => {
    const turn = fullTurn({
      gcStart: gc(),
      gcEnd: gc({ failOpenCount: 1 }),
    });
    const lines = formatDetail(turn!, 1);
    expect(lines.some((line) => line.includes("Fail-open"))).toBe(true);
  });

  test("no GC activity -> no GC section", () => {
    const turn = fullTurn({ usage: { totalInputTokens: 5 } });
    const lines = formatDetail(turn!, 1);
    expect(lines.includes("Context GC")).toBe(false);
  });
});
