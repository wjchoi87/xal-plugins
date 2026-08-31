import { describe, expect, test } from "bun:test";
import { formatDuration, formatTokens, formatTps } from "../../lib/format";
import { MetricsCollector } from "../../metrics/collector";
import { formatCompact } from "../../metrics/formatter";
import { fakeClock, session } from "./helpers";
import type { StreamEvent } from "../../types";

const text = (): StreamEvent => ({ type: "text_delta", text: "x" });
const done = (): StreamEvent => ({ type: "done" });

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
