/*
 * /context-gc command (#22 in INSTRUCTION.md).
 *
 * Default: cumulative per-session stats summary.
 *   /context-gc status            detailed view for the current session
 *   /context-gc cleanup           conservative report (deletes nothing)
 *   /context-gc cleanup <session> destructive: deletes one session's pages
 *                                   after an explicit interactive confirm
 */

import type { Command, CommandContext } from "./types";
import type { PageStore } from "./storage/page-store";
import { formatBytes } from "./storage/page-store";
import type { StatsStore } from "./storage/stats-store";

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
  const reclaimed = snapshot.reclaimedBytes;
  const observed = snapshot.observedBytes;
  const percent =
    observed > 0 ? ((reclaimed / observed) * 100).toFixed(1) : "0.0";
  ctx.print("Context GC");
  ctx.print(`observed  ${formatBytes(snapshot.observedBytes)}`);
  ctx.print(`emitted   ${formatBytes(snapshot.emittedBytes)}`);
  ctx.print(`reclaimed ${formatBytes(reclaimed)} (${percent}%)`);
  ctx.print(`paged     ${snapshot.outputsPaged}`);
  ctx.print(`kept raw  ${snapshot.outputsKeptRaw}`);
  ctx.print(`dedup     ${snapshot.duplicateHits}`);
  ctx.print(`recalls   ${snapshot.recalls}`);
  ctx.print(`fail-open ${snapshot.failOpenCount}`);
  if (snapshot.storeFailures > 0) {
    ctx.print(`store-fail ${snapshot.storeFailures}`);
  }
}

async function runStatus(
  ctx: CommandContext,
  stats: StatsStore,
  pages: PageStore,
): Promise<void> {
  const sessionId = ctx.session.id;
  await runSummary(ctx, stats);
  const pagesInSession = await pages.sessionPages(sessionId);
  ctx.print("");
  ctx.print(`session ${sessionId}`);
  ctx.print(
    `pages ${pagesInSession.length} (${formatBytes(pagesInSession.reduce((sum, p) => sum + p.rawBytes, 0))})`,
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
    `deleting ${sessionPages.length} pages (${formatBytes(sessionPages.reduce((sum, p) => sum + p.rawBytes, 0))}) of session ${targetSession}`,
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
