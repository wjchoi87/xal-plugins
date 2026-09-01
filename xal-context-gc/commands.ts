/*
 * /context-gc command (#22 in INSTRUCTION.md).
 *
 * Default: cumulative per-session stats summary.
 *   /context-gc status            detailed view for the current session
 *   /context-gc cleanup           conservative report (deletes nothing)
 *   /context-gc cleanup <session> destructive: deletes one session's pages
 *                                   after an explicit interactive confirm
 *
 * UI policy: the summary answers "how much context inflow did GC prevent?"
 *   - `emitted` (bytes returned to XAL for modified outputs only) is
 *     intentionally NOT shown: it is not the final model-facing context
 *     size, so it reads as misleading next to `observed`. It stays in the
 *     stats file and in `/context-gc status` for debugging.
 *   - `reclaimed` ratio is `reclaimedBytes / observedBytes` — the fraction
 *     of observed tool-output bytes kept out of context. This is NOT a token
 *     savings rate.
 *   - zero-value noise (dedup 0, fail-open 0) is hidden from the summary.
 */

import type { Command, CommandContext } from "./types";
import type { PageStore } from "./storage/page-store";
import { formatBytes } from "./storage/page-store";
import type { StatsStore } from "./storage/stats-store";

const LABEL_WIDTH = 13;

function line(label: string, value: string): string {
  return `${label.padEnd(LABEL_WIDTH)}${value}`;
}

export function contextGcCommand(stats: StatsStore, pages: PageStore): Command {
  return {
    name: "context-gc",
    describe: "show context-gc paging statistics",
    async run(args, ctx) {
      const [sub] = args;
      if (sub === "status") {
        await runStatus(ctx, stats, pages);
        return;
      }
      if (sub === "cleanup") {
        await runCleanup(ctx, pages, args.slice(1));
        return;
      }
      await runSummary(ctx, stats);
    },
  };
}

async function runSummary(
  ctx: CommandContext,
  stats: StatsStore,
): Promise<void> {
  const sessionId = ctx.session.id;
  const snapshot = await stats.snapshot(sessionId);
  const percent =
    snapshot.observedBytes > 0
      ? ((snapshot.reclaimedBytes / snapshot.observedBytes) * 100).toFixed(1)
      : "0.0";

  ctx.print("Context GC");
  ctx.print("");
  ctx.print(line("observed", formatBytes(snapshot.observedBytes)));
  ctx.print(
    line("reclaimed", `${formatBytes(snapshot.reclaimedBytes)} (${percent}%)`),
  );
  ctx.print("");
  ctx.print(line("paged", String(snapshot.outputsPaged)));
  ctx.print(line("kept", String(snapshot.outputsKeptRaw)));
  if (snapshot.duplicateHits > 0) {
    ctx.print(line("dedup", String(snapshot.duplicateHits)));
  }
  ctx.print(line("recalls", String(snapshot.recalls)));
  if (snapshot.failOpenCount > 0) {
    ctx.print(line("fail-open", String(snapshot.failOpenCount)));
  }
  if (snapshot.storeFailures > 0) {
    ctx.print(line("store-fail", String(snapshot.storeFailures)));
  }
}

async function runStatus(
  ctx: CommandContext,
  stats: StatsStore,
  pages: PageStore,
): Promise<void> {
  const sessionId = ctx.session.id;
  await runSummary(ctx, stats);
  const snapshot = await stats.snapshot(sessionId);
  const pagesInSession = await pages.sessionPages(sessionId);
  ctx.print("");
  ctx.print(`session ${sessionId}`);
  ctx.print(
    `pages ${pagesInSession.length} (${formatBytes(
      pagesInSession.reduce((sum, p) => sum + p.rawBytes, 0),
    )})`,
  );
  ctx.print(
    `emitted ${formatBytes(
      snapshot.emittedBytes,
    )} (bytes returned to XAL for GC-modified outputs only)`,
  );
  ctx.print(
    "storage usage is capped by maxStorageMb; see README for retention",
  );
}

async function runCleanup(
  ctx: CommandContext,
  pages: PageStore,
  args: string[],
): Promise<void> {
  const [targetSession] = args;
  if (!targetSession) {
    const sessions = await pages.listSessions();
    const total = await pages.totalBytes();
    ctx.print("Context GC cleanup — conservative report (nothing deleted):");
    ctx.print(`sessions with pages: ${sessions.length}`);
    ctx.print(`stored page bytes: ${formatBytes(total)}`);
    ctx.print("");
    ctx.print("resumable sessions are never touched automatically.");
    ctx.print(
      "to destructively delete one session's pages: /context-gc cleanup <session-id>",
    );
    return;
  }

  const sessionPages = await pages.sessionPages(targetSession);
  ctx.print(
    `deleting ${sessionPages.length} pages (${formatBytes(
      sessionPages.reduce((sum, p) => sum + p.rawBytes, 0),
    )}) of session ${targetSession}`,
  );
  const answer = await ctx.ask(
    "type the session id to confirm permanent deletion (anything else cancels):",
  );
  if (answer !== targetSession) {
    ctx.print("cleanup cancelled.");
    return;
  }
  const removed = await pages.removeSession(targetSession);
  ctx.print(
    removed
      ? `removed session ${targetSession}`
      : `failed to remove session ${targetSession}`,
  );
}
