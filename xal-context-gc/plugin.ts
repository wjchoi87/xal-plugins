/*
 * Plugin entry point (#25 in INSTRUCTION.md).
 *
 * Registers (when enabled):
 *   - one static prompt section (stable cache prefix)
 *   - context_gc_recall tool (bounded exact retrieval)
 *   - afterTool hook running the ingress engine (fail-open)
 *   - /context-gc command (per-session stats)
 *
 * The hook must never throw: XAL replaces a failing hook's output with an
 * error description, so every path returns undefined instead.
 */

import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { parseContextGcConfig } from "./config";
import { contextGcCommand } from "./commands";
import { createContextGcPrompt } from "./prompt";
import { ContextGcEngine } from "./gc/ingress";
import { NoopHistoryGcAdapter } from "./gc/history-adapter";
import { PageStore } from "./storage/page-store";
import { StatsStore } from "./storage/stats-store";
import { createRecallTool } from "./tools/recall";
import type { Hook, Plugin } from "./types";

const plugin: Plugin = {
  name: "context-gc",
  register(ctx) {
    const resolved = parseContextGcConfig(ctx.config);
    const config = resolved.config;
    if (!config.enabled) return;

    const root = join(ctx.runtime.paths.home, "context-gc");
    const pagesRoot = join(root, "pages");
    const statsRoot = join(root, "stats");

    // Best-effort: engine and tools fail open even if root creation fails.
    mkdir(statsRoot, { recursive: true, mode: 0o700 }).catch(() => undefined);

    const storageMaxBytes = config.maxStorageMb * 1024 * 1024;
    const pages = new PageStore(pagesRoot, storageMaxBytes);
    const stats = new StatsStore(statsRoot, config.persistence);
    const engine = new ContextGcEngine(resolved, pages, stats);

    // Historical GC abstraction: no-op by default (#20).
    const historyAdapter = new NoopHistoryGcAdapter();

    ctx.registerPrompt(createContextGcPrompt());

    ctx.registerTool(createRecallTool(pages, stats, config));

    ctx.registerHook(createIngressHook(engine));
    ctx.registerCommand(contextGcCommand(stats, pages));

    // Historical GC abstraction ships as a no-op until a public XAL
    // conversation-transform hook exists (#20). NoopHistoryGcAdapter is
    // exercised directly by unit tests.
    void historyAdapter;
  },
};

export function createIngressHook(engine: ContextGcEngine): Hook {
  return {
    name: "context-gc",
    afterTool(input, ctx) {
      return safe(async () => {
        const result = await engine.process({
          sessionId: ctx.session.id,
          callId: input.callId,
          tool: input.tool,
          args: input.args,
          title: input.title,
          readOnly: input.readOnly,
          output: input.output,
        });
        if (!result.changed || result.output === undefined) return undefined;
        return { type: "replace", output: result.output } as const;
      });
    },
  };
}

/** Every code path must fail open: return undefined, never throw (#25). */
function safe(execute: () => Promise<unknown>): Promise<undefined> {
  return execute().then(
    (value) => (value === undefined ? undefined : undefined),
    (error) => {
      console.error("[context-gc] hook failed open:", error);
      return undefined;
    },
  );
}

export default plugin;
