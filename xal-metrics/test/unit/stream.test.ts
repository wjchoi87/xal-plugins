import { describe, expect, test } from "bun:test";
import { MetricsCollector } from "../../metrics/collector";
import { tokensPerSecond } from "../../metrics/stream";
import { fakeClock, session } from "./helpers";
import type { StreamEvent } from "../../types";

const text = (): StreamEvent => ({ type: "text_delta", text: "x" });
const reasoning = (): StreamEvent => ({ type: "reasoning_delta", text: "x" });
const done = (): StreamEvent => ({ type: "done" });

describe("streaming metrics (#13–17)", () => {
  test("text deltas and done compute TTFT, generation and TPS", () => {
    const clock = fakeClock();
    const collector = new MetricsCollector({ clock });
    collector.start(session());
    clock.advance(200);
    collector.stream("session-a", text());
    clock.advance(1100);
    collector.stream("session-a", text());
    clock.advance(100);
    collector.stream("session-a", done());
    const completed = collector.finish("session-a", { outputTokens: 87 });

    expect(completed!.firstEventAt).toBe(200);
    expect(completed!.firstTextAt).toBe(200);
    expect(completed!.generationMs).toBe(1200);
    expect(completed!.stalls).toEqual([1100]);
    expect(tokensPerSecond(completed!)).toBeCloseTo(72.5, 1);
    expect(completed!.lastStreamAt).toBe(1400);
  });

  test("gaps below the threshold are not stalls", () => {
    const clock = fakeClock();
    const collector = new MetricsCollector({ clock });
    collector.start(session());
    collector.stream("session-a", text());
    clock.advance(400);
    collector.stream("session-a", text());
    clock.advance(400);
    collector.stream("session-a", done());
    const completed = collector.finish("session-a", {});

    expect(completed!.stalls).toEqual([]);
    expect(completed!.generationMs).toBe(800);
  });

  test("a round boundary is not a stall (#16)", () => {
    const clock = fakeClock();
    const collector = new MetricsCollector({ clock });
    collector.start(session());
    collector.stream("session-a", text());
    clock.advance(100);
    collector.stream("session-a", done());
    clock.advance(5000);
    collector.stream("session-a", text());
    clock.advance(100);
    const completed = collector.finish("session-a", {});

    expect(completed!.stalls).toEqual([]);
    // round 1: 100ms of generation; round 2 closes at finish time
    expect(completed!.generationMs).toBe(100 + 100);
  });

  test("reasoning before text records first reasoning and first event", () => {
    const clock = fakeClock();
    const collector = new MetricsCollector({ clock });
    collector.start(session());
    clock.advance(300);
    collector.stream("session-a", reasoning());
    clock.advance(1200);
    collector.stream("session-a", text());
    const completed = collector.finish("session-a", {});

    expect(completed!.firstEventAt).toBe(300);
    expect(completed!.firstReasoningAt).toBe(300);
    expect(completed!.firstTextAt).toBe(1500);
  });

  test("TTFT is first-text latency (#14)", () => {
    const clock = fakeClock();
    const collector = new MetricsCollector({ clock });
    collector.start(session());
    clock.advance(700);
    collector.stream("session-a", reasoning());
    clock.advance(600);
    collector.stream("session-a", text());
    collector.stream("session-a", done());
    const completed = collector.finish("session-a", {});

    expect(completed!.firstReasoningAt! - completed!.startedAt!).toBe(700);
    expect(completed!.firstTextAt! - completed!.startedAt!).toBe(1300);
  });

  test("custom stall threshold from configuration is honored", () => {
    const clock = fakeClock();
    const collector = new MetricsCollector({ clock, stallThresholdMs: 500 });
    collector.start(session());
    collector.stream("session-a", text());
    clock.advance(600);
    collector.stream("session-a", text());
    collector.stream("session-a", done());
    const completed = collector.finish("session-a", {});

    expect(completed!.stalls).toEqual([600]);
  });

  test("outputTokens missing -> no TPS, no estimation (#15, #42)", () => {
    const clock = fakeClock();
    const collector = new MetricsCollector({ clock });
    collector.start(session());
    collector.stream("session-a", text());
    clock.advance(1000);
    collector.stream("session-a", done());
    clock.advance(1000);
    const completed = collector.finish("session-a", {});

    expect(completed!.generationMs).toBe(1000);
    expect(completed!.outputTokens).toBeUndefined();
    expect(tokensPerSecond(completed!)).toBeUndefined();
  });

  test("stream events without an active turn are ignored", () => {
    const collector = new MetricsCollector({ clock: fakeClock() });
    collector.stream("ghost", text());
    expect(collector.finish("ghost", {})).toBeUndefined();
  });
});
