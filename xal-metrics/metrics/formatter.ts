/*
 * Display policy (#21–26).
 *
 * compact milestones:
 *   Legacy:            6.4s · in 18.2K · out 621
 *   + cache:           6.4s · in 18.2K · out 621 · cache 92%
 *   Stream:            TPS 72.4 · TTFT 1.3s · 6.4s · in 18.2K · out 621
 *   + stall:           TPS 72.4 · TTFT 1.3s · 6.4s · in 18.2K · out 621 · cache 92% · stall 2.1s×1
 *
 * Order is fixed: streaming metrics first, then turn duration, tokens,
 * cache and stalls. Nothing unavailable is shown — no N/A placeholders (#50).
 *
 * Tool statistics stay out of the compact line (internal + detail only),
 * per the metric priority list (#23). XAL's plugin API does not expose the
 * terminal width, so no responsive shrinking system is built (#23).
 *
 * TTFT is fixed as first-text latency (#14); first-event and
 * first-reasoning latencies remain available in the detail view.
 */

import {
  formatDuration,
  formatPercent,
  formatPercentDetail,
  formatTps,
  formatTokens,
} from "../lib/format";
import type { CompletedTurn, TurnMetrics } from "./collector";
import { cacheCoverage, contextCacheCoverage, hasContextUsage } from "./usage";
import {
  estimateGcSavedTokens,
  estimateWithoutGcContext,
} from "../integrations/context-gc";
import {
  firstEventLatencyMs,
  firstReasoningLatencyMs,
  firstTextLatencyMs,
  maxStallMs,
  totalStallMs,
  tokensPerSecond,
} from "./stream";

function turnDurationMs(turn: TurnMetrics): number | undefined {
  if (turn.startedAt === undefined) return undefined;
  const end = turn.completedAt ?? turn.lastStreamAt;
  if (end === undefined || end < turn.startedAt) return undefined;
  return end - turn.startedAt;
}

function positiveTokens(tokens: number | undefined): number | undefined {
  if (tokens === undefined || tokens <= 0) return undefined;
  return tokens;
}

export function formatCompact(turn: TurnMetrics): string | undefined {
  const parts: string[] = [];

  const tps = tokensPerSecond(turn);
  if (tps !== undefined) parts.push(`TPS ${formatTps(tps)}`);
  const ttft = firstTextLatencyMs(turn);
  if (ttft !== undefined) parts.push(`TTFT ${formatDuration(ttft)}`);
  const turnMs = turnDurationMs(turn);
  if (turnMs !== undefined) parts.push(formatDuration(turnMs));

  // ctx is the latest provider round's input footprint (current context),
  // not the aggregated turn input (#6).
  const ctx = positiveTokens(turn.contextInputTokens);
  if (ctx !== undefined) parts.push(`ctx ${formatTokens(ctx)}`);
  const input = positiveTokens(turn.totalInputTokens);
  if (input !== undefined) parts.push(`in ${formatTokens(input)}`);
  const output = positiveTokens(turn.outputTokens);
  if (output !== undefined) parts.push(`out ${formatTokens(output)}`);

  const coverage = cacheCoverage(turn);
  if (coverage !== undefined && coverage > 0)
    parts.push(`cache ${formatPercent(coverage)}%`);
  // Estimated GC-reclaimed context tokens; hidden when nothing was reclaimed.
  const saved = estimateGcSavedTokens(turn);
  if (saved !== undefined) parts.push(`gc ~${formatTokens(saved)}`);
  const maxStall = maxStallMs(turn);
  if (maxStall !== undefined)
    parts.push(`stall ${formatDuration(maxStall)}×${turn.stalls.length}`);

  return parts.length === 0 ? undefined : parts.join(" · ");
}

/** Detail view (#26): one metric family per line, index is 1 for the most recent turn. */
export function formatDetail(turn: CompletedTurn, index: number): string[] {
  const lines = [`#${index}  ${turn.model}`, `Provider   ${turn.provider}`];

  const timing: string[] = [];
  const ttft = firstTextLatencyMs(turn);
  if (ttft !== undefined) timing.push(`TTFT       ${formatDuration(ttft)}`);
  const firstEvent = firstEventLatencyMs(turn);
  if (firstEvent !== undefined)
    timing.push(`First evt  ${formatDuration(firstEvent)}`);
  const firstReasoning = firstReasoningLatencyMs(turn);
  if (firstReasoning !== undefined)
    timing.push(`Reasoning  ${formatDuration(firstReasoning)}`);
  if (turn.generationMs !== undefined)
    timing.push(`Generation ${formatDuration(turn.generationMs)}`);
  const turnMs = turnDurationMs(turn);
  if (turnMs !== undefined) timing.push(`Turn       ${formatDuration(turnMs)}`);
  const tps = tokensPerSecond(turn);
  if (tps !== undefined) timing.push(`TPS        ${formatTps(tps)}`);
  if (timing.length > 0) lines.push("", ...timing);

  // Sections are omitted entirely when no field is available (#6, #29).
  for (const section of [
    turnUsageSection(turn),
    contextSection(turn),
    gcSection(turn),
  ]) {
    if (section) lines.push("", ...section);
  }

  if (turn.toolCount > 0) {
    lines.push("");
    lines.push(`Tools      ${turn.toolCount}`);
    lines.push(`Tool time  ${formatDuration(turn.toolDurationMs)}`);
    for (const stat of turn.toolStats) {
      const calls = stat.count > 1 ? ` ×${stat.count}` : "";
      lines.push(
        `           ${stat.tool}${calls} ${formatDuration(stat.totalMs)}`,
      );
    }
  }

  if (turn.stalls.length > 0) {
    lines.push("");
    const max = maxStallMs(turn)!;
    const total = totalStallMs(turn)!;
    lines.push(`Stalls     ${turn.stalls.length}`);
    lines.push(
      `Max stall  ${formatDuration(max)} (total ${formatDuration(total)})`,
    );
  }

  if (turn.wallCompletedAt !== undefined) {
    lines.push(
      `At         ${new Date(turn.wallCompletedAt).toLocaleTimeString()}`,
    );
  }
  return lines;
}

const padLabel = (label: string, value: string): string =>
  `  ${label.padEnd(13)}${value}`;

/** Whole-turn aggregate usage (turnEnd.usage): labelled as turn usage (#6). */
function turnUsageSection(turn: TurnMetrics): string[] | undefined {
  const lines: string[] = [];
  const input = positiveTokens(turn.totalInputTokens);
  if (input !== undefined)
    lines.push(padLabel("Input", input.toLocaleString("en-US")));
  const output = positiveTokens(turn.outputTokens);
  if (output !== undefined)
    lines.push(padLabel("Output", output.toLocaleString("en-US")));
  const cacheRead = positiveTokens(turn.cacheReadTokens);
  if (cacheRead !== undefined)
    lines.push(padLabel("Cache read", cacheRead.toLocaleString("en-US")));
  const cacheWrite = positiveTokens(turn.cacheWriteTokens);
  if (cacheWrite !== undefined)
    lines.push(padLabel("Cache write", cacheWrite.toLocaleString("en-US")));
  const coverage = cacheCoverage(turn);
  if (coverage !== undefined)
    lines.push(padLabel("Cache cov", `${formatPercentDetail(coverage)}%`));
  if (lines.length === 0) return undefined;
  return ["Turn usage", ...lines];
}

/** Latest provider round usage (turnEnd.context): the current context footprint. */
function contextSection(turn: TurnMetrics): string[] | undefined {
  if (!hasContextUsage(turn)) return undefined;
  const lines: string[] = [];
  const input = positiveTokens(turn.contextInputTokens);
  if (input !== undefined)
    lines.push(padLabel("Input", input.toLocaleString("en-US")));
  const cacheRead = positiveTokens(turn.contextCacheReadTokens);
  if (cacheRead !== undefined)
    lines.push(padLabel("Cache read", cacheRead.toLocaleString("en-US")));
  const cacheWrite = positiveTokens(turn.contextCacheWriteTokens);
  if (cacheWrite !== undefined)
    lines.push(padLabel("Cache write", cacheWrite.toLocaleString("en-US")));
  const coverage = contextCacheCoverage(turn);
  if (coverage !== undefined)
    lines.push(padLabel("Cache cov", `${formatPercentDetail(coverage)}%`));
  if (lines.length === 0) return undefined;
  return ["Context", ...lines];
}

/**
 * Context GC section (#14). Surfaced values are token estimates prefixed with
 * "~": GC-reclaimed context tokens and the estimated context size without GC.
 * Exact byte figures stay in persisted metrics but are not shown in the UI.
 * Zero/no-data noise is hidden; Fail-open appears only when > 0.
 */
function gcSection(turn: TurnMetrics): string[] | undefined {
  const lines: string[] = [];
  const saved = estimateGcSavedTokens(turn);
  if (saved !== undefined)
    lines.push(padLabel("GC saved", `~${saved.toLocaleString("en-US")}`));
  const withoutGc = estimateWithoutGcContext(turn);
  if (withoutGc !== undefined)
    lines.push(padLabel("Without GC", `~${withoutGc.toLocaleString("en-US")}`));
  const paged = positiveCount(turn.gcPagedOutputs);
  if (paged !== undefined) lines.push(padLabel("Paged", String(paged)));
  const dedup = positiveCount(turn.gcDedupHits);
  if (dedup !== undefined) lines.push(padLabel("Dedup", String(dedup)));
  const recalls = positiveCount(turn.gcRecalls);
  if (recalls !== undefined) lines.push(padLabel("Recalls", String(recalls)));
  if (positiveCount(turn.gcFailOpen) !== undefined)
    lines.push(padLabel("Fail-open", String(turn.gcFailOpen)));
  if (lines.length === 0) return undefined;
  return ["Context GC", ...lines];
}

function positiveBytes(bytes: number | undefined): number | undefined {
  if (bytes === undefined || bytes <= 0) return undefined;
  return bytes;
}

function positiveCount(count: number | undefined): number | undefined {
  return positiveBytes(count);
}
