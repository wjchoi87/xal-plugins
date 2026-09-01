/*
 * Usage normalization semantics.
 *
 * XAL normalizes provider usage in apps/cli/src/providers:
 * - anthropic-messages.ts: totalInputTokens = input + cacheRead + cacheWrite
 * - chat-completions.ts:   totalInputTokens = raw.prompt_tokens (cached tokens included)
 * - responses.ts:          totalInputTokens = raw.input_tokens (cached tokens included)
 *
 * So XAL's totalInputTokens is the full prompt footprint and already contains
 * cacheRead tokens. Cache hit rate therefore divides cacheRead by that same
 * total footprint — not by an uncached-only denominator.
 *
 * undefined/0 policy: a field is stored only when XAL provides it. undefined
 * means "provider did not provide this" and 0 means "provided and truly zero".
 * Both are kept distinct in the metrics record, only display policy may hide
 * zeros as meaningless.
 */

import type { Usage } from "../types";
import type { TurnMetrics } from "./collector";

export function applyUsage(
  turn: Pick<
    TurnMetrics,
    "totalInputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens"
  >,
  usage: Usage | undefined,
): void {
  if (!usage) return;
  if (usage.totalInputTokens !== undefined)
    turn.totalInputTokens = usage.totalInputTokens;
  if (usage.outputTokens !== undefined) turn.outputTokens = usage.outputTokens;
  if (usage.cacheReadInputTokens !== undefined)
    turn.cacheReadTokens = usage.cacheReadInputTokens;
  if (usage.cacheWriteInputTokens !== undefined)
    turn.cacheWriteTokens = usage.cacheWriteInputTokens;
}

export function cacheCoverage(turn: {
  cacheReadTokens?: number;
  totalInputTokens?: number;
}): number | undefined {
  if (turn.cacheReadTokens === undefined || turn.totalInputTokens === undefined)
    return undefined;
  if (turn.totalInputTokens <= 0) return undefined;
  const coverage = turn.cacheReadTokens / turn.totalInputTokens;
  if (coverage > 1) return undefined;
  return coverage;
}

export function hasCacheUse(turn: {
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): boolean {
  return (
    turn.cacheReadTokens !== undefined || turn.cacheWriteTokens !== undefined
  );
}

/*
 * Context usage semantics.
 *
 * XAL's turnEnd.context is the usage of the latest provider round — much
 * closer to the actual current model-facing context footprint at the end of
 * the turn than turnEnd.usage, which aggregates every provider round in the
 * turn (multiple rounds happen on tool loops). Context fields are kept under
 * separate names so they can never be confused with the turn aggregates.
 */

export function applyContextUsage(
  turn: Pick<
    TurnMetrics,
    | "contextInputTokens"
    | "contextCacheReadTokens"
    | "contextCacheWriteTokens"
    | "contextOutputTokens"
  >,
  usage: Usage | undefined,
): void {
  if (!usage) return;
  if (usage.totalInputTokens !== undefined)
    turn.contextInputTokens = usage.totalInputTokens;
  if (usage.cacheReadInputTokens !== undefined)
    turn.contextCacheReadTokens = usage.cacheReadInputTokens;
  if (usage.cacheWriteInputTokens !== undefined)
    turn.contextCacheWriteTokens = usage.cacheWriteInputTokens;
  if (usage.outputTokens !== undefined)
    turn.contextOutputTokens = usage.outputTokens;
}

export function contextCacheCoverage(turn: {
  contextCacheReadTokens?: number;
  contextInputTokens?: number;
}): number | undefined {
  if (
    turn.contextCacheReadTokens === undefined ||
    turn.contextInputTokens === undefined
  )
    return undefined;
  if (turn.contextInputTokens <= 0) return undefined;
  const coverage = turn.contextCacheReadTokens / turn.contextInputTokens;
  if (coverage > 1) return undefined;
  return coverage;
}

export function hasContextUsage(turn: {
  contextInputTokens?: number;
  contextCacheReadTokens?: number;
  contextCacheWriteTokens?: number;
  contextOutputTokens?: number;
}): boolean {
  return (
    turn.contextInputTokens !== undefined ||
    turn.contextCacheReadTokens !== undefined ||
    turn.contextCacheWriteTokens !== undefined ||
    turn.contextOutputTokens !== undefined
  );
}
