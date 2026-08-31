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

import { applyUsage } from "./usage";
import {
  freshStreamState,
  applyStreamEvent,
  closeOpenRound,
  type StreamState,
} from "./stream";
import { mergeToolStat, ToolTracker, type ToolStat } from "./tools";
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

  start(session: HookSession): void {
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

  finish(
    sessionId: string,
    usage: Usage | undefined,
  ): CompletedTurn | undefined {
    const activeTurn = this.active.get(sessionId);
    if (!activeTurn) return undefined;
    this.active.delete(sessionId);
    applyUsage(activeTurn.turn, usage);
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
