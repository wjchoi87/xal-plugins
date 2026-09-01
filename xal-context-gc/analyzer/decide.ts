/*
 * Deterministic disposition decision (#7, #9 in INSTRUCTION.md).
 *
 * Decision order matters:
 *   1. recall tool output is never paged
 *   2. small outputs stay
 *   3. write-tool outputs stay (state-change confirmation)
 *   4. explicit narrow file reads stay
 *   5. definite failures become KEEP_CORE (full log still paged)
 *   6. large tool-family outputs become PAGE
 *   7. anything uncertain becomes DEFER (equals KEEP_RAW in output)
 *
 * DEDUP_REF is decided by the engine (it needs the session index), not here.
 */

import type { ToolFamily, ToolMeta } from "./classify";
import { classifyTool } from "./classify";
import { extractFailureCore, isDefiniteFailure } from "./failure-core";
import { countBytes, countLines } from "./normalize";
import type { ResolvedContextGcConfig } from "../config";

/**
 * Context disposition (#8). TRIM_LOSSLESS stays reserved for stats/metrics;
 * v1 never emits a trimmed-only replacement.
 */
export type ContextDisposition =
  "KEEP_RAW" | "KEEP_CORE" | "PAGE" | "DEDUP_REF" | "TRIM_LOSSLESS" | "DEFER";

export type PageCategory =
  "file" | "search" | "command" | "test" | "error" | "status" | "generic";

export interface AnalyzeInput {
  tool: string;
  args: Record<string, unknown>;
  title: string;
  readOnly: boolean;
  output: string;
}

export interface AnalyzeResult {
  disposition: ContextDisposition;
  family: ToolFamily;
  category: PageCategory;
  isWrite: boolean;
  meta: ToolMeta;
  bytes: number;
  lines: number;
  reason: string;
}

/** True when the command string looks like a test runner invocation. */
function isTestCommand(command: string | undefined): boolean {
  if (!command) return false;
  const trimmed = command.trim();
  return /(?:^|\s|\/)(?:npm run test|npm test|pnpm test|yarn test|bun test|pytest|go test|jest|cargo test|vitest|mvn test|gradle test|dotnet test)(?:\s|$)/.test(
    trimmed,
  );
}

function isBuildCommand(command: string | undefined): boolean {
  if (!command) return false;
  const trimmed = command.trim();
  return /(?:^|\s|\/)(?:npm run build|pnpm build|yarn build|bun build|make|cmake --build|cargo build|go build|tsc|babel|webpack|vite build|next build)(?:\s|$)/.test(
    trimmed,
  );
}

function failureCore(output: string, family: ToolFamily): string {
  return extractFailureCore(output, family);
}

export function analyzeOutput(
  input: AnalyzeInput,
  resolved: ResolvedContextGcConfig,
): AnalyzeResult | undefined {
  const { config, thresholds } = resolved;
  const meta = classifyTool(input.tool, input.args, input.title);
  const bytes = countBytes(input.output);
  const lines = countLines(input.output);
  const family = meta.family;

  const keep = (
    reason: string,
    category: PageCategory = "generic",
  ): AnalyzeResult => ({
    disposition: "KEEP_RAW",
    family,
    category,
    isWrite: meta.isWrite,
    meta,
    bytes,
    lines,
    reason,
  });

  if (family === "recall") {
    return keep("recall output is never recursively paged (#9.5)", "search");
  }
  if (bytes === 0) {
    return keep("empty output");
  }
  if (meta.isWrite) {
    return keep(
      "write-tool output confirms state change; kept in context",
      "command",
    );
  }

  // Effective family threshold.
  let threshold: number;
  switch (family) {
    case "file":
      threshold = thresholds.file;
      break;
    case "search":
      threshold = thresholds.search;
      break;
    case "status":
    case "command":
      threshold = thresholds.command;
      break;
    default:
      threshold = thresholds.generic;
  }

  if (bytes < threshold) {
    return keep(
      `small output (${bytes}B < ${threshold}B)`,
      categoryFor(input, meta),
    );
  }

  // Explicit narrow reads are exactly what the agent asked for.
  if (family === "file" && meta.explicitNarrowRange) {
    return keep("explicit narrow file range requested (#9.1)", "file");
  }

  // Generic (unknown) tools: uncertain classification stays unchanged unless
  // it is unambiguously huge in balanced/aggressive modes.
  if (family === "generic") {
    if (config.mode === "conservative") {
      return undefined; // DEFER
    }
    if (bytes < 64 * 1024) return undefined; // DEFER
    return {
      disposition: "PAGE",
      family,
      category: "generic",
      isWrite: meta.isWrite,
      meta,
      bytes,
      lines,
      reason: "huge generic output, balanced/aggressive mode",
    };
  }

  // Definite failures keep actionable core in context.
  if (isDefiniteFailure(input.output, family)) {
    const core = failureCore(input.output, family);
    if (core.length > 0) {
      return {
        disposition: "KEEP_CORE",
        family,
        category: "error",
        isWrite: meta.isWrite,
        meta,
        bytes,
        lines,
        reason: "definite failure signal with actionable core",
      };
    }
    return undefined; // DEFER: signal without extractable core is uncertain
  }

  switch (family) {
    case "file":
      return {
        disposition: "PAGE",
        family,
        category: "file",
        isWrite: meta.isWrite,
        meta,
        bytes,
        lines,
        reason: "large file read (#9.1)",
      };
    case "search":
      return {
        disposition: "PAGE",
        family,
        category: "search",
        isWrite: meta.isWrite,
        meta,
        bytes,
        lines,
        reason: "large search/grep result (#9.2)",
      };
    case "status":
      return {
        disposition: "PAGE",
        family,
        category: "status",
        isWrite: meta.isWrite,
        meta,
        bytes,
        lines,
        reason: "large or repeated status output (#9.4)",
      };
    case "command":
      return {
        disposition: "PAGE",
        family,
        category: isTestCommand(meta.command)
          ? "test"
          : isBuildCommand(meta.command)
            ? "command"
            : "command",
        isWrite: meta.isWrite,
        meta,
        bytes,
        lines,
        reason: "large command output, no failure signal (#9.3)",
      };
    default:
      return undefined; // DEFER
  }
}

function categoryFor(input: AnalyzeInput, meta: ToolMeta): PageCategory {
  if (meta.isWrite) return "command";
  if (meta.family === "file") return "file";
  if (meta.family === "search") return "search";
  if (meta.family === "status") return "status";
  if (meta.family === "command") {
    return isTestCommand(meta.command) ? "test" : "command";
  }
  return "generic";
}
