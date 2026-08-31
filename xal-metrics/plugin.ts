/*
 * Plugin entry point.
 *
 * The metrics hook registers unconditionally for all five events. XAL
 * runtimes without stream-hook support ignore the `stream` field entirely
 * (hook registration is field-lookup based) and every other handler keeps
 * working — no version checks, no configuration to opt in (#36, #49).
 *
 * Failure isolation (#43): XAL propagates hook failures into the agent turn,
 * so every handler here is guarded. A metrics bug drops metrics, never the
 * agent run.
 */

import { join } from "node:path";
import { metricsCommand } from "./commands";
import { parseMetricsConfig } from "./config";
import { MetricsCollector } from "./metrics/collector";
import { streamEventHandler } from "./metrics/stream";
import { MetricsWriter } from "./storage/writer";
import type { Hook, Plugin } from "./types";

const plugin: Plugin = {
  name: "metrics",
  register(ctx) {
    const config = parseMetricsConfig(ctx.config);
    if (!config.enabled) return;

    const collector = new MetricsCollector({
      stallThresholdMs: config.stallThresholdMs,
    });
    const writer = config.persistence
      ? new MetricsWriter(
          join(ctx.runtime.paths.home, "metrics", "metrics.jsonl"),
        )
      : undefined;

    ctx.registerHook(metricsHook(collector, writer));
    ctx.registerCommand(metricsCommand(collector));
  },
};

export function metricsHook(
  collector: MetricsCollector,
  writer: MetricsWriter | undefined,
): Hook {
  const handleStream = streamEventHandler(
    collector,
    collector.stallThresholdMs,
  );
  return {
    name: "metrics",
    prompt: (input, ctx) => safe(() => collector.start(ctx.session)),
    beforeTool: (input, ctx) =>
      safe(() => collector.beginTool(ctx.session.id, input.callId, input.tool)),
    afterTool: (input, ctx) =>
      safe(() => collector.endTool(ctx.session.id, input.callId)),
    stream: (input, ctx) => safe(() => handleStream(input, ctx)),
    turnEnd: (input, ctx) =>
      safeAsync(async () => {
        const completed = collector.finish(ctx.session.id, input.usage);
        if (completed && writer) await writer.append(completed);
      }),
  };
}

function safe(execute: () => unknown): undefined {
  try {
    execute();
  } catch {
    // metrics failures must never break the agent turn (#43)
  }
  return undefined;
}

function safeAsync(execute: () => Promise<void>): Promise<void> {
  return execute().catch(() => undefined);
}

export default plugin;
