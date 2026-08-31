/*
 * /metrics command: list recent turns in compact form, drill into one turn
 * in detail. This is the plugin's UI surface (#25): XAL's public UI
 * extension API has no slot for assistant-message metadata, so the command
 * interface is used and the limitation is documented in the README.
 *
 * /metrics              — 10 most recent turns, compact
 * /metrics last         — most recent turn, detail
 * /metrics <n>          — n-th most recent turn, detail
 * /metrics session <id> — most recent turns for one session
 */

import type { Command, CommandContext } from "./types";
import { formatCompact, formatDetail } from "./metrics/formatter";
import type { CompletedTurn, MetricsCollector } from "./metrics/collector";

const LIST_LIMIT = 10;

function parseTurnNumber(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined;
  const number = Number(raw);
  return number >= 1 ? number : undefined;
}

export function metricsCommand(collector: MetricsCollector): Command {
  return {
    name: "metrics",
    describe: "show per-turn timing and usage metrics",
    async run(args, ctx) {
      const history = [...collector.history()].reverse();
      if (history.length === 0) {
        ctx.print("metrics: no completed turns yet");
        return;
      }
      const [first, second] = args;
      if (first === undefined || first === "last") {
        printDetail(ctx, collector, history[0]!);
        return;
      }
      if (first === "session") {
        if (!second) {
          ctx.print("metrics: /metrics session <session-id>");
          return;
        }
        const turns = history.filter((turn) => turn.sessionId === second);
        if (turns.length === 0) {
          ctx.print(`metrics: no completed turns for session ${second}`);
          return;
        }
        printList(ctx, collector, turns.slice(0, LIST_LIMIT));
        return;
      }
      const number = parseTurnNumber(first);
      if (number === undefined) {
        ctx.print("metrics: /metrics [last|<n>|session <session-id>]");
        return;
      }
      const target = history[number - 1];
      if (!target) {
        ctx.print(`metrics: no turn #${number} (have ${history.length})`);
        return;
      }
      printDetail(ctx, collector, target);
    },
  };
}

/** Index of the turn counting from the most recent (1), in the shared history. */
function recentIndex(collector: MetricsCollector, turn: CompletedTurn): number {
  const history = collector.history();
  for (let index = history.length - 1; index >= 0; index--) {
    if (history[index] === turn) return history.length - index;
  }
  return 1;
}

function printDetail(
  ctx: CommandContext,
  collector: MetricsCollector,
  turn: CompletedTurn,
): void {
  for (const line of formatDetail(turn, recentIndex(collector, turn)))
    ctx.print(line);
}

function printList(
  ctx: CommandContext,
  collector: MetricsCollector,
  turns: CompletedTurn[],
): void {
  for (let index = 0; index < turns.length; index++) {
    const turn = turns[index]!;
    const compact = formatCompact(turn);
    ctx.print(`#${recentIndex(collector, turn)}  ${compact ?? "no metrics"}`);
  }
  ctx.print("");
  ctx.print("use /metrics last or /metrics <n> for detail");
}
