/*
 * Exact deduplication (#16 in INSTRUCTION.md).
 *
 * v1 supports exact/safe-normalized duplicate detection only — no embeddings,
 * no fuzzy matching. Duplicate hits replace the second occurrence with a
 * compact reference to the first page (descriptor stays immutable).
 */

import type { PageStore, ContextPage } from "../storage/page-store";
import { duplicateDescriptor } from "./descriptor";

export async function findDuplicatePage(
  pages: PageStore,
  sessionId: string,
  normalizedSha256: string,
): Promise<ContextPage | undefined> {
  return pages.lookupByNormalizedHash(sessionId, normalizedSha256);
}

export function renderDuplicate(page: ContextPage): string {
  return duplicateDescriptor(page);
}
