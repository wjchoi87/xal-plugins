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
  formatTps,
  formatTokens,
} from "../lib/format";
import type { CompletedTurn, TurnMetrics } from "./collector";
import { cacheCoverage } from "./usage";
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

  const input = positiveTokens(turn.totalInputTokens);
  if (input !== undefined) parts.push(`in ${formatTokens(input)}`);
  const output = positiveTokens(turn.outputTokens);
  if (output !== undefined) parts.push(`out ${formatTokens(output)}`);

  const coverage = cacheCoverage(turn);
  if (coverage !== undefined && coverage > 0)
    parts.push(`cache ${formatPercent(coverage)}%`);
  const maxStall = maxStallMs(turn);
  if (maxStall !== undefined)
    parts.push(`stall ${formatDuration(maxStall)}×${turn.stalls.length}`);

  return parts.length === 0 ? undefined : parts.join(" · ");
}

/** Detail view (#26): one metric family per line, index is 1 for the most recent turn. */
export function formatDetail(turn: CompletedTurn, index: number): string[] {
  const lines = [`#${index}  ${turn.model}`, `Provider   ${turn.provider}`];

  const ttft = firstTextLatencyMs(turn);
  if (ttft !== undefined) lines.push(`TTFT       ${formatDuration(ttft)}`);
  const firstEvent = firstEventLatencyMs(turn);
  if (firstEvent !== undefined)
    lines.push(`First evt  ${formatDuration(firstEvent)}`);
  const firstReasoning = firstReasoningLatencyMs(turn);
  if (firstReasoning !== undefined)
    lines.push(`Reasoning  ${formatDuration(firstReasoning)}`);
  if (turn.generationMs !== undefined)
    lines.push(`Generation ${formatDuration(turn.generationMs)}`);
  const turnMs = turnDurationMs(turn);
  if (turnMs !== undefined) lines.push(`Turn       ${formatDuration(turnMs)}`);
  const tps = tokensPerSecond(turn);
  if (tps !== undefined) lines.push(`TPS        ${formatTps(tps)}`);

  const each = (tokens: number | undefined): number | undefined =>
    positiveTokens(tokens);
  const input = each(turn.totalInputTokens);
  if (input !== undefined)
    lines.push(`Input      ${input.toLocaleString("en-US")}`);
  const cacheRead = positiveTokens(turn.cacheReadTokens);
  if (cacheRead !== undefined)
    lines.push(`Cache read ${cacheRead.toLocaleString("en-US")}`);
  const cacheWrite = positiveTokens(turn.cacheWriteTokens);
  if (cacheWrite !== undefined)
    lines.push(`Cache write ${cacheWrite.toLocaleString("en-US")}`);
  const output = positiveTokens(turn.outputTokens);
  if (output !== undefined)
    lines.push(`Output     ${output.toLocaleString("en-US")}`);
  const coverage = cacheCoverage(turn);
  if (coverage !== undefined)
    lines.push(`Cache hit  ${formatPercent(coverage)}%`);

  if (turn.toolCount > 0) {
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
