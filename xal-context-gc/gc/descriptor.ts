/*
 * Page descriptors (#13 in INSTRUCTION.md).
 *
 * A descriptor is a compact, machine-oriented replacement for paged output.
 * The preview is always bounded and made of exact original lines (head/tail
 * slices); nothing is summarized semantically. Descriptors are immutable once
 * committed to history (never rewritten later, #7.2).
 */

import { countBytes } from "../analyzer/normalize";
import { formatBytes, type ContextPage } from "../storage/page-store";

export interface DescriptorOptions {
  previewBytes: number;
}

/** Head/tail preview split budget (60% head / 40% tail). */
const HEAD_RATIO = 0.6;

export function pageDescriptor(
  page: ContextPage,
  raw: string,
  options: DescriptorOptions,
): string {
  const preview = boundedPreview(raw, options.previewBytes);
  const header = `[context-gc ${pageDescriptorTag(page)}]`;
  const lines = [`${header} Large tool output was paged losslessly.`, ""];

  if (preview.head.length > 0) {
    lines.push("Exact preview (head):", "");
    lines.push(preview.head);
  }
  if (preview.omitted) {
    lines.push("", `... ${preview.omitted} omitted ...`, "");
    if (preview.tail.length > 0) {
      lines.push("Exact preview (tail):", "");
      lines.push(preview.tail);
    }
  }
  lines.push("", "Omitted content is available exactly via context_gc_recall.");
  lines.push("Use a query or line range; do not guess omitted content.");
  return lines.join("\n");
}

export function coreDescriptor(page: ContextPage, core: string): string {
  const header = `[context-gc ${pageDescriptorTag(page)}]`;
  return [
    `${header} Failure core kept in context:`,
    "",
    core,
    "",
    "Full log paged losslessly. Exact content is available via context_gc_recall.",
    "Use a query or line range; do not guess omitted content.",
  ].join("\n");
}

export function duplicateDescriptor(page: ContextPage): string {
  return [
    `[context-gc duplicate ${pageDescriptorTag(page)}]`,
    "This tool output is identical to previously paged content.",
    "Recall the referenced page only if exact content is required.",
  ].join("\n");
}

/** HEADER payload shared by all descriptor forms. */
export function pageDescriptorTag(page: ContextPage): string {
  return `page=${page.id} tool=${page.tool} raw=${formatBytes(page.rawBytes)} lines=${page.rawLines}`;
}

export interface Preview {
  head: string;
  tail: string;
  omitted: number;
}

/**
 * Bounded exact preview made of whole original lines. The middle is excised
 * when the output is too large for the budget.
 */
export function boundedPreview(output: string, previewBytes: number): Preview {
  const headBudget = Math.max(64, Math.round(previewBytes * HEAD_RATIO));
  const tailBudget = Math.max(64, previewBytes - headBudget);
  const lines = output.split("\n");

  const headLines: string[] = [];
  let headBytes = 0;
  for (const line of lines) {
    const byteLength = countBytes(line) + 1;
    if (headBytes + byteLength > headBudget) break;
    headLines.push(line);
    headBytes += byteLength;
  }

  const remaining = lines.length - headLines.length;
  const tailLines: string[] = [];
  let tailBytes = 0;
  if (remaining > 0) {
    for (let index = lines.length - 1; index >= headLines.length; index--) {
      if (tailLines.length >= 60) break; // cap tail lines independently
      const line = lines[index]!;
      const byteLength = countBytes(line) + 1;
      if (tailBytes + byteLength > tailBudget) break;
      tailLines.unshift(line);
      tailBytes += byteLength;
    }
  }

  const omitted = lines.length - headLines.length - tailLines.length;
  if (omitted <= 2) {
    // Include the near-tail lines in the head so no real content is dropped.
    const merged = lines.slice(headLines.length).join("\n");
    return {
      head:
        merged === "" ? lines.join("\n") : `${headLines.join("\n")}\n${merged}`,
      tail: "",
      omitted: 0,
    };
  }
  return {
    head: headLines.join("\n"),
    tail: tailLines.join("\n"),
    omitted,
  };
}
