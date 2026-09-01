/*
 * Turn-scoped metrics collection.
 *
 * A turn starts at the prompt hook and ends at the turnEnd hook. State is
 * keyed by session id because primary and subagent sessions may interleave;
 * a repeated prompt for the same session (e.g. after an interrupt) discards
 * the unfinished turn instead of merging into it. Turn duration uses the
 * monotonic clock (performance.now); wall clock is kept separately only for
 * display timestamps.
 */

import { applyContextUsage, applyUsage } from "./usage";
import {
  freshStreamState,
  applyStreamEvent,
  closeOpenRound,
  type StreamState,
} from "./stream";
import { mergeToolStat, ToolTracker, type ToolStat } from "./tools";
import {
  diffGc,
  type GcSnapshot,
  type TurnGcMetrics,
} from "../integrations/context-gc";
import type { HookSession, StreamEvent, Usage } from "../types";

export interface TurnMetrics {
  sessionId: string;
  provider: string;
  model: string;
  startedAt?: number;
  wallStartedAt?: number;
  firstEventAt?: number;
  firstReasoningAt?: number;
  firstTextAt?: number;
  lastStreamAt?: number;
  generationMs?: number;
  completedAt?: number;
  wallCompletedAt?: number;
  totalInputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Latest provider round usage (turnEnd.context), not the turn aggregate. */
  contextInputTokens?: number;
  contextCacheReadTokens?: number;
  contextCacheWriteTokens?: number;
  contextOutputTokens?: number;
  /** Per-turn Context GC deltas (byte reduction before output enters history). */
  gcObservedBytes?: number;
  gcEmittedBytes?: number;
  gcReclaimedBytes?: number;
  gcPagedOutputs?: number;
  gcDedupHits?: number;
  gcRecalls?: number;
  gcFailOpen?: number;
  toolCount: number;
  toolDurationMs: number;
  toolStats: ToolStat[];
  stalls: number[];
}

export interface CompletedTurn extends TurnMetrics {
  completedAt: number;
  wallCompletedAt: number;
}

export interface Clock {
  now(): number;
  wallNow(): number;
}

export interface CollectorOptions {
  clock?: Clock;
  maxHistory?: number;
  stallThresholdMs?: number;
}

const systemClock: Clock = {
  now: () => performance.now(),
  wallNow: () => Date.now(),
};

const DEFAULT_MAX_HISTORY = 100;
const DEFAULT_STALL_THRESHOLD_MS = 1_000;

interface ActiveTurn {
  turn: TurnMetrics;
  stream: StreamState;
  tools: ToolTracker;
  gcStart?: GcSnapshot;
}

export class MetricsCollector {
  private readonly clock: Clock;
  private readonly maxHistory: number;
  readonly stallThresholdMs: number;
  private readonly active = new Map<string, ActiveTurn>();
  private turns: CompletedTurn[] = [];

  constructor(options: CollectorOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.maxHistory = options.maxHistory ?? DEFAULT_MAX_HISTORY;
    this.stallThresholdMs =
      options.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
  }

  /**
   * Starts a turn. `gcStart` is the Context GC cumulative snapshot read at the
   * prompt hook; turn GC metrics are derived from its delta against the
   * snapshot read at turn end (#10).
   */
  start(session: HookSession, gcStart?: GcSnapshot): void {
    this.active.set(session.id, {
      turn: {
        sessionId: session.id,
        provider: session.provider,
        model: session.model,
        startedAt: this.clock.now(),
        wallStartedAt: this.clock.wallNow(),
        toolCount: 0,
        toolDurationMs: 0,
        toolStats: [],
        stalls: [],
      },
      stream: freshStreamState(),
      tools: new ToolTracker(),
      gcStart,
    });
  }

  beginTool(sessionId: string, callId: string, tool: string): void {
    const activeTurn = this.active.get(sessionId);
    if (!activeTurn) return;
    activeTurn.tools.begin(callId, tool, this.clock.now());
  }

  endTool(sessionId: string, callId: string): void {
    const activeTurn = this.active.get(sessionId);
    if (!activeTurn) return;
    const ended = activeTurn.tools.end(callId, this.clock.now());
    if (!ended) return;
    activeTurn.turn.toolCount += 1;
    activeTurn.turn.toolDurationMs += ended.durationMs;
    mergeToolStat(activeTurn.turn.toolStats, ended.stat);
  }

  stream(
    sessionId: string,
    event: StreamEvent,
    stallThresholdMs = this.stallThresholdMs,
  ): void {
    const activeTurn = this.active.get(sessionId);
    if (!activeTurn) return;
    applyStreamEvent(
      activeTurn.turn,
      activeTurn.stream,
      event,
      this.clock.now(),
      stallThresholdMs,
    );
  }

  /**
   * Completes a turn. `usage` is the whole-turn aggregate from turnEnd.usage,
   * `context` is the latest provider round usage from turnEnd.context, kept
   * separate so the current context footprint can never be confused with the
   * turn aggregate (#3, #4). `gcEnd` is the Context GC snapshot read at turn
   * end; the per-turn delta is computed against the turn-start snapshot.
   */
  finish(
    sessionId: string,
    usage: Usage | undefined,
    context: Usage | undefined = undefined,
    gcEnd?: GcSnapshot,
  ): CompletedTurn | undefined {
    const activeTurn = this.active.get(sessionId);
    if (!activeTurn) return undefined;
    this.active.delete(sessionId);
    applyUsage(activeTurn.turn, usage);
    applyContextUsage(activeTurn.turn, context);
    const gcDelta = diffGc(activeTurn.gcStart, gcEnd);
    if (gcDelta) applyTurnGc(activeTurn.turn, gcDelta);
    closeOpenRound(activeTurn.turn, activeTurn.stream, this.clock.now());
    const now = this.clock.now();
    const completed: CompletedTurn = {
      ...activeTurn.turn,
      completedAt: now,
      wallCompletedAt: this.clock.wallNow(),
    };
    this.turns.push(completed);
    if (this.turns.length > this.maxHistory) {
      this.turns = this.turns.slice(this.turns.length - this.maxHistory);
    }
    return completed;
  }

  history(): readonly CompletedTurn[] {
    return this.turns;
  }

  lastTurn(sessionId: string): CompletedTurn | undefined {
    for (let index = this.turns.length - 1; index >= 0; index--) {
      const turn = this.turns[index]!;
      if (turn.sessionId === sessionId) return turn;
    }
    return undefined;
  }
}

/** Maps per-turn GC deltas onto the persistent TurnMetrics field names. */
function applyTurnGc(turn: TurnMetrics, gc: TurnGcMetrics): void {
  if (gc.observedBytes !== undefined) turn.gcObservedBytes = gc.observedBytes;
  if (gc.emittedBytes !== undefined) turn.gcEmittedBytes = gc.emittedBytes;
  if (gc.reclaimedBytes !== undefined)
    turn.gcReclaimedBytes = gc.reclaimedBytes;
  if (gc.outputsPaged !== undefined) turn.gcPagedOutputs = gc.outputsPaged;
  if (gc.duplicateHits !== undefined) turn.gcDedupHits = gc.duplicateHits;
  if (gc.recalls !== undefined) turn.gcRecalls = gc.recalls;
  if (gc.failOpen !== undefined) turn.gcFailOpen = gc.failOpen;
}
