/*
 * Stable prompt section (#15 in INSTRUCTION.md).
 *
 * One short static section telling the agent how to interact with paged
 * content. Requirements: static across turns, no token counts, no page
 * inventory, no changing GC statistics, no model-specific wording. This
 * keeps the provider prompt prefix stable for cache efficiency (#7.2).
 */

import type { PromptSection } from "./types";

const CONTEXT_GC_PROMPT = [
  "Some large tool outputs are replaced with [context-gc page=...] descriptors.",
  "The omitted raw output is preserved exactly and can be retrieved with context_gc_recall.",
  "Never guess omitted page content; recall it exactly when needed.",
  "Prefer a targeted query or line range over retrieving an entire page.",
].join("\n");

export function createContextGcPrompt(): PromptSection {
  return {
    id: "context-gc",
    text() {
      return CONTEXT_GC_PROMPT;
    },
  };
}
