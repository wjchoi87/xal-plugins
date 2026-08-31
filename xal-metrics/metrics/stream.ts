/*
 * Streaming metrics from XAL's optional stream hook.
 *
 * This is the only module (besides the shared types snapshot) that works
 * with XAL's stream event API directly (#38). The rest of the plugin talks
 * to turns through the collector. In XAL versions without the stream hook,
 * nothing here ever runs — the registered `stream` field is simply unknown
 * to the older registry and the base metrics keep working (#36).
 *
 * Stall policy (#16): only gaps between text/reasoning deltas count. `done`
 * and `item_done` break the delta chain so provider round boundaries and
 * tool execution windows are never reported as stalls.
 *
 * Generation duration: per round, (done - first text), accumulated across
 * rounds. Tool calls between rounds stay excluded from generation time but
 * remain visible in turn duration (#18).
 *
 * Hot path (#41): one timestamp + a couple of field assignments per delta;
 * no writes, no formatting, no aggregation.
 */

import type { MetricsCollector } from "./collector";
import type { HookContext, StreamEvent, StreamHookInput } from "../types";

export const STALL_THRESHOLD_MS = 1_000;

export interface StreamState {
  lastDeltaAt?: number;
  deltaChainBroken: boolean;
  roundFirstTextAt?: number;
}

export function freshStreamState(): StreamState {
  return { deltaChainBroken: true };
}

export function applyStreamEvent(
  turn: TurnStreamFields,
  state: StreamState,
  event: StreamEvent,
  now: number,
  stallThresholdMs = STALL_THRESHOLD_MS,
): void {
  switch (event.type) {
    case "text_delta":
      if (turn.firstEventAt === undefined) turn.firstEventAt = now;
      if (turn.firstTextAt === undefined) turn.firstTextAt = now;
      if (state.roundFirstTextAt === undefined) state.roundFirstTextAt = now;
      recordDelta(turn, state, now, stallThresholdMs);
      break;
    case "reasoning_delta":
    case "reasoning_summary_delta":
      if (turn.firstEventAt === undefined) turn.firstEventAt = now;
      if (turn.firstReasoningAt === undefined) turn.firstReasoningAt = now;
      recordDelta(turn, state, now, stallThresholdMs);
      break;
    case "item_done":
      // Item boundaries are not text/reasoning deltas: a gap after one is a
      // round or tool boundary, never a stall (#16).
      state.deltaChainBroken = true;
      break;
    case "done":
      closeRound(turn, state, now);
      break;
  }
  turn.lastStreamAt = now;
}

export interface TurnStreamFields {
  startedAt?: number;
  outputTokens?: number;
  firstEventAt?: number;
  firstReasoningAt?: number;
  firstTextAt?: number;
  lastStreamAt?: number;
  generationMs?: number;
  stalls: number[];
}

function recordDelta(
  turn: TurnStreamFields,
  state: StreamState,
  now: number,
  stallThresholdMs: number,
): void {
  if (state.lastDeltaAt !== undefined && !state.deltaChainBroken) {
    const gap = now - state.lastDeltaAt;
    if (gap >= stallThresholdMs) turn.stalls.push(gap);
  }
  state.lastDeltaAt = now;
  state.deltaChainBroken = false;
}

function closeRound(
  turn: TurnStreamFields,
  state: StreamState,
  now: number,
): void {
  if (state.roundFirstTextAt !== undefined && now > state.roundFirstTextAt) {
    turn.generationMs =
      (turn.generationMs ?? 0) + (now - state.roundFirstTextAt);
    state.roundFirstTextAt = undefined;
  }
  state.deltaChainBroken = true;
}

/** Closes a round that was still open when the turn ended without a final done event. */
export function closeOpenRound(
  turn: TurnStreamFields,
  state: StreamState,
  now: number,
): void {
  closeRound(turn, state, now);
}

export function firstEventLatencyMs(
  turn: TurnStreamFields,
): number | undefined {
  if (turn.firstEventAt === undefined || turn.startedAt === undefined)
    return undefined;
  return Math.max(0, turn.firstEventAt - turn.startedAt);
}

export function firstReasoningLatencyMs(
  turn: TurnStreamFields,
): number | undefined {
  if (turn.firstReasoningAt === undefined || turn.startedAt === undefined)
    return undefined;
  return Math.max(0, turn.firstReasoningAt - turn.startedAt);
}

export function firstTextLatencyMs(turn: TurnStreamFields): number | undefined {
  if (turn.firstTextAt === undefined || turn.startedAt === undefined)
    return undefined;
  return Math.max(0, turn.firstTextAt - turn.startedAt);
}

/** TPS is always derived from XAL's normalized outputTokens (#15, #42). */
export function tokensPerSecond(turn: TurnStreamFields): number | undefined {
  if (turn.outputTokens === undefined) return undefined;
  if (turn.generationMs === undefined || turn.generationMs <= 0)
    return undefined;
  return (turn.outputTokens / turn.generationMs) * 1_000;
}

export function maxStallMs(turn: TurnStreamFields): number | undefined {
  if (turn.stalls.length === 0) return undefined;
  return Math.max(...turn.stalls);
}

export function totalStallMs(turn: TurnStreamFields): number | undefined {
  if (turn.stalls.length === 0) return undefined;
  return turn.stalls.reduce((total, stall) => total + stall, 0);
}

/**
 * Stream hook glue: keeps StreamEvent/StreamHookInput usage out of plugin.ts.
 * The hook is registered unconditionally; XAL runtimes without stream hook
 * support simply never invoke it.
 */
export function streamEventHandler(
  collector: MetricsCollector,
  stallThresholdMs: number,
): (input: StreamHookInput, ctx: HookContext) => void {
  return (input, ctx) => {
    collector.stream(ctx.session.id, input.event, stallThresholdMs);
  };
}
