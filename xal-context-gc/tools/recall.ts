/*
 * context_gc_recall tool (#14 in INSTRUCTION.md).
 *
 * Bounded exact retrieval from paged content. Two modes:
 *   line range  -> exact original lines
 *   literal query -> exact matching lines with 1-based line numbers and
 *                    bounded neighboring lines
 *
 * Never allows unlimited dumps: max bytes is defaulted from config and hard
 * capped. The recall response itself is never paged by the engine, and a
 * failed recall returns a message instead of throwing.
 */

import { splitLines, countBytes } from "../analyzer/normalize";
import type { ContextGcConfig } from "../config";
import type { PageStore } from "../storage/page-store";
import type { StatsStore } from "../storage/stats-store";
import type { Tool } from "../types";

export interface RecallArgs {
  page_id?: string;
  start_line?: number;
  end_line?: number;
  query?: string;
  context_lines?: number;
  max_bytes?: number;
}

export const RECALL_HEADER = "[context-gc recall]";

export function createRecallTool(
  pages: PageStore,
  stats: StatsStore,
  config: ContextGcConfig,
): Tool {
  return {
    name: "context_gc_recall",
    description:
      "Retrieve exact content that context-gc paged out of a large tool output. " +
      "Accepts page_id (required) plus either a 1-based line range (start_line/end_line) " +
      "or a literal query string (case-sensitive substring with surrounding lines). " +
      "Results are bounded by max_bytes. Never guess the omitted content of a page; " +
      "recall the exact bytes with this tool when the information is needed.",
    parameters: {
      type: "object",
      properties: {
        page_id: {
          type: "string",
          description: "Page id from the [context-gc page=...] descriptor",
        },
        start_line: {
          type: "integer",
          minimum: 1,
          description: "First line to return (1-based, inclusive)",
        },
        end_line: {
          type: "integer",
          minimum: 1,
          description: "Last line to return (1-based, inclusive)",
        },
        query: {
          type: "string",
          minLength: 1,
          description: "Literal substring to find in the paged content",
        },
        context_lines: {
          type: "integer",
          minimum: 0,
          maximum: 10,
          description: "Lines around each query match (default 2)",
        },
        max_bytes: {
          type: "integer",
          minimum: 256,
          description: `Result size cap (default ${config.recallDefaultBytes}, max ${config.recallMaxBytes})`,
        },
      },
      required: ["page_id"],
      additionalProperties: false,
    },
    title(args) {
      return `Recall context-gc page ${String(args.page_id ?? "?")}`;
    },
    readOnly() {
      return true;
    },
    async execute(args, ctx) {
      return {
        output: await runRecall(args as RecallArgs, {
          pages,
          stats,
          config,
          sessionId: ctx.sessionId,
        }),
      };
    },
  };
}

interface RecallDeps {
  pages: PageStore;
  stats: StatsStore;
  config: ContextGcConfig;
  sessionId: string;
}

async function runRecall(args: RecallArgs, deps: RecallDeps): Promise<string> {
  const { pages, stats, config, sessionId } = deps;
  const pageId = typeof args.page_id === "string" ? args.page_id.trim() : "";
  if (pageId.length === 0) {
    return usage();
  }

  await stats.note(sessionId, { recalls: 1 });

  const page = await pages.getPage(sessionId, pageId).catch(() => undefined);
  if (!page) {
    return `${RECALL_HEADER} page not found in this session: ${pageId}`;
  }

  const raw = await pages.readRaw(page).catch(() => undefined);
  if (raw === undefined) {
    return `${RECALL_HEADER} page content missing on disk: ${pageId}`;
  }

  const maxBytes = clampMaxBytes(args.max_bytes, config);
  const mode = args.query !== undefined ? "query" : "range";

  const startLine = positiveInteger(args.start_line);
  const endLine = positiveInteger(args.end_line);

  if (mode === "range") {
    const lines = splitLines(raw);
    const total = lines.length;
    const start =
      startLine !== undefined ? Math.min(startLine, Math.max(1, total)) : 1;
    const end = endLine !== undefined ? Math.min(endLine, total) : total;
    if (start > end) {
      return `${RECALL_HEADER} invalid range: start_line ${start} > end_line ${end} (page has ${total} lines)`;
    }
    const sliced = lines.slice(start - 1, end);
    const { text, truncated } = sliceToBytes(sliced, maxBytes);
    const linesLabel = total === 0 ? "empty" : `${start}-${end}`;
    const hint = truncated
      ? `\n[truncated; request another range if needed]`
      : "";
    return `[context-gc recall page=${pageId} lines=${linesLabel}]${text.length > 0 ? "\n" + text : ""}${hint}`;
  }

  // literal query mode
  const query = args.query!;
  const contextLines =
    typeof args.context_lines === "number" &&
    Number.isInteger(args.context_lines)
      ? Math.max(0, Math.min(10, args.context_lines))
      : 2;
  const lines = splitLines(raw);
  const matched: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (lines[index]!.includes(query)) {
      const start = Math.max(0, index - contextLines);
      const end = Math.min(lines.length - 1, index + contextLines);
      for (let lineIndex = start; lineIndex <= end; lineIndex++) {
        matched.push(`${lineIndex + 1} | ${lines[lineIndex]}`);
      }
    }
  }
  // Deduplicate overlapping line-number entries and keep document order.
  const unique = [...new Set(matched)];
  const { text, truncated } = sliceToBytes(unique, maxBytes);
  const hint = truncated
    ? `\n[truncated; narrow the query or request a line range]`
    : "";
  return `[context-gc recall page=${pageId} query=${JSON.stringify(query)}]${text.length > 0 ? "\n" + text : ""}${hint}`;
}

function usage(): string {
  return [
    RECALL_HEADER,
    "usage: page_id (required) + one of:",
    "  start_line/end_line  exact 1-based line range",
    "  query                literal substring, with context_lines",
    "  max_bytes            size cap (default 12288, hard max 32768)",
  ].join("\n");
}

function clampMaxBytes(
  value: number | undefined,
  config: ContextGcConfig,
): number {
  const fallback = config.recallDefaultBytes;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 256) {
    return fallback;
  }
  return Math.min(Math.floor(value), config.recallMaxBytes);
}

function positiveInteger(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  return value >= 1 ? value : undefined;
}

function sliceToBytes(
  lines: string[],
  maxBytes: number,
): { text: string; truncated: boolean } {
  const parts: string[] = [];
  let used = 0;
  for (const line of lines) {
    const byteLength = countBytes(line) + 1;
    if (parts.length > 0 && used + byteLength > maxBytes) {
      return { text: parts.join("\n"), truncated: true };
    }
    parts.push(line);
    used += byteLength;
  }
  return { text: parts.join("\n"), truncated: false };
}
