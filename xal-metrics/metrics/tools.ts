/* Per-tool timing aggregation: duration per callId plus per-tool totals. */

export interface ToolStat {
  tool: string;
  count: number;
  totalMs: number;
  maxMs: number;
}

export class ToolTracker {
  private readonly starts = new Map<string, { tool: string; at: number }>();

  begin(callId: string, tool: string, at: number): void {
    this.starts.set(callId, { tool, at });
  }

  end(
    callId: string,
    at: number,
  ): { stat: ToolStat; durationMs: number } | undefined {
    const start = this.starts.get(callId);
    if (!start) return undefined;
    this.starts.delete(callId);
    const durationMs = Math.max(0, at - start.at);
    return {
      durationMs,
      stat: {
        tool: start.tool,
        count: 1,
        totalMs: durationMs,
        maxMs: durationMs,
      },
    };
  }
}

export function mergeToolStat(stats: ToolStat[], incoming: ToolStat): void {
  const existing = stats.find((candidate) => candidate.tool === incoming.tool);
  if (!existing) {
    stats.push(incoming);
    return;
  }
  existing.count += incoming.count;
  existing.totalMs += incoming.totalMs;
  existing.maxMs = Math.max(existing.maxMs, incoming.maxMs);
}
