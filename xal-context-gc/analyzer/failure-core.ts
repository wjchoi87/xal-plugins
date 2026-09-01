/*
 * Failure-core preservation (#17 in INSTRUCTION.md).
 *
 * A complex failure must never be reduced to "build failed". When a large
 * output is classified as a failure, the full raw log is paged and an
 * actionable core stays directly in context: diagnostics, file:line hits,
 * failing test identifiers and bounded neighboring lines.
 *
 * All detection here is deterministic text matching. Nothing semantic is
 * invented; the core is always made of exact original lines.
 */

import { countBytes, splitLines } from "./normalize";
import type { ToolFamily } from "./classify";

export interface FailureCoreOptions {
  /** Hard cap on core output size in bytes (descriptor target ~8 KiB). */
  maxCoreBytes?: number;
  /** Neighboring lines kept around each signal line. */
  contextLines?: number;
  /** Cap on the number of signal spans included. */
  maxSpans?: number;
}

export const DEFAULT_FAILURE_CORE_OPTIONS: Required<FailureCoreOptions> = {
  maxCoreBytes: 8_192,
  contextLines: 2,
  maxSpans: 24,
};

/** Strong, unambiguous failure markers (compiler/runtime/test/persistence). */
const STRONG_FAILURE_PATTERNS: RegExp[] = [
  /\bError\s*:/,
  /\bAssertionError\b/,
  /\bTypeError\b/,
  /\bReferenceError\b/,
  /\bSyntaxError\b/,
  /\bRangeError\b/,
  /\bURIError\b/,
  /\bEvalError\b/,
  /error\s+TS\d+/,
  /error\s+[A-Z]\d+/,
  /\berror\s*\[\s*[A-Za-z0-9_-]+\s*\]/,
  /\[error\]/,
  /\bpanic\b/i,
  /\bfatal\b/i,
  /\bcrash\b/i,
  /BUILD FAILED/i,
  /COMPILATION FAILED/i,
  /Tests?.*\bfailed\b/i,
  /(?:^|\n)\s*(?:FAIL|FAILED|NOT OK)\b/i,
  /(?:^|\n)\s*(?:✗|✘|×|✖|✕)\s?/,
  /(?:^|\n)\s*not ok\b/i,
  /non-zero exit/i,
  /exit(?:ed)? with (?:code |status )?[1-9]\d*/,
  /\bExited with code [1-9]\d*/,
  /\bexception\b/i,
  /\bpending exceptions?\b/i,
];

/** Softer markers only meaningful when they repeat across many lines. */
const SOFT_FAILURE_TOKEN =
  /\b(failed|failure|failing|exception|stack trace|at .*\(.*:\d+:\d+\))\b/i;

/** Compiler-style diagnostics: path/to/file.ts:12:34 (or path:12:34). */
const DIAGNOSTIC_LINE = /\b[\w./\\-]+(?:\.\w+)?:\d+(?::\d+)?\b/;

const SUCCESS_COUNTER =
  /(?:^|\n)\s*(?:0 (?:errors|failures?|failed)|tests? passed|ok\.\s*\d+ tests?)/i;

export function hasExplicitSuccess(output: string): boolean {
  return SUCCESS_COUNTER.test(output);
}

/** Scan the raw output for a definite failure signal. */
export function isDefiniteFailure(output: string, family: ToolFamily): boolean {
  if (family !== "command" && family !== "generic" && family !== "status") {
    return false;
  }
  if (hasExplicitSuccess(output)) return false;

  for (const pattern of STRONG_FAILURE_PATTERNS) {
    if (pattern.test(output)) return true;
  }

  // Repeated soft markers across many lines (e.g. a long stack dump) also
  // qualify; the extracted core preserves every hit line anyway.
  let softHits = 0;
  for (const line of splitLines(output)) {
    if (SOFT_FAILURE_TOKEN.test(line)) softHits += 1;
    if (softHits >= 6) return true;
  }
  return false;
}

interface SignalSpan {
  start: number;
  end: number;
}

function isSignalLine(line: string): boolean {
  for (const pattern of STRONG_FAILURE_PATTERNS) {
    if (pattern.test(line)) return true;
  }
  if (SOFT_FAILURE_TOKEN.test(line)) return true;
  return DIAGNOSTIC_LINE.test(line);
}

/**
 * Extract the actionable failure core as exact original lines with 1-based
 * line numbers so the agent can recall the same span later. Returns an empty
 * string when no signal could be found.
 */
export function extractFailureCore(
  output: string,
  family: ToolFamily,
  options: FailureCoreOptions = {},
): string {
  if (!isDefiniteFailure(output, family)) return "";
  const opts = { ...DEFAULT_FAILURE_CORE_OPTIONS, ...options };
  const lines = splitLines(output);
  const hits: number[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (isSignalLine(lines[index] ?? "")) hits.push(index);
  }
  if (hits.length === 0) return "";

  // Merge overlapping spans (signal line +/- context).
  const spans: SignalSpan[] = [];
  for (const hit of hits) {
    const start = Math.max(0, hit - opts.contextLines);
    const end = Math.min(lines.length - 1, hit + opts.contextLines);
    const last = spans[spans.length - 1];
    if (last && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
    } else {
      spans.push({ start, end });
    }
  }

  const limited = spans.slice(0, opts.maxSpans);
  const parts: string[] = [];
  let bytes = 0;
  for (const span of limited) {
    for (let index = span.start; index <= span.end; index++) {
      const line = lines[index] ?? "";
      const literal = `${index + 1} | ${line}`;
      bytes += countBytes(literal) + 1;
      if (bytes > opts.maxCoreBytes) return parts.join("\n");
      parts.push(literal);
    }
    if (span !== limited[limited.length - 1]) {
      parts.push(
        `... +${hits.length - limited.length} more spans omitted; use context_gc_recall for the full log`,
      );
      break;
    }
  }
  return parts.join("\n");
}
