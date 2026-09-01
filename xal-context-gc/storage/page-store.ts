/*
 * Exact page storage (#11, #12 in INSTRUCTION.md).
 *
 * Pages are stored per session as exact raw text files with a JSONL metadata
 * index. The normalized hash index enables exact dedupe (#16). Page-identity
 * is derived from content (sha256 over sessionId + callId + raw hash), never
 * from a random id.
 *
 * Storage failures never throw: writePage returns { ok: false } and the
 * engine passes the original output through unchanged (#7.1, #11).
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  appendJsonlLine,
  atomicWriteFile,
  DIR_MODE,
  PAGE_FILE_MODE,
} from "./index";
import { countBytes, countLines, sha256Hex } from "../analyzer/normalize";
import type { PageCategory } from "../analyzer/decide";

export interface ContextPage {
  id: string;
  sessionId: string;

  tool: string;
  callId: string;
  argsHash: string;

  createdAt: number;

  rawBytes: number;
  rawLines: number;

  rawSha256: string;
  normalizedSha256: string;

  storagePath: string;

  classification: PageCategory;

  title?: string;
  readOnly?: boolean;
}

export function pageIdOf(
  sessionId: string,
  callId: string,
  rawSha256: string,
): string {
  return createHash("sha256")
    .update(`${sessionId}\u0000${callId}\u0000${rawSha256}`, "utf8")
    .digest("hex")
    .slice(0, 16);
}

export function argsHashOf(args: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(args), "utf8")
    .digest("hex")
    .slice(0, 12);
}

export type PageWriteResult =
  | { ok: true; page: ContextPage; existed: boolean }
  | { ok: false; error: string };

/**
 * Loads and caches one session's page index. `byNormalized` keeps the first
 * page id per normalized hash so dedupe always points at the oldest page.
 */
class SessionPageIndex {
  readonly byId = new Map<string, ContextPage>();
  private readonly byNormalized = new Map<string, string>();

  constructor(pages: Iterable<ContextPage>, _loadedAt = Date.now()) {
    for (const page of pages) this.add(page);
  }

  private add(page: ContextPage): void {
    const existing = this.byId.get(page.id);
    if (existing && existing.createdAt >= page.createdAt) return;
    this.byId.set(page.id, page);
    if (!this.byNormalized.has(page.normalizedSha256)) {
      this.byNormalized.set(page.normalizedSha256, page.id);
    }
  }

  lookup(id: string): ContextPage | undefined {
    return this.byId.get(id);
  }

  lookupByNormalizedHash(hash: string): ContextPage | undefined {
    const id = this.byNormalized.get(hash);
    return id === undefined ? undefined : this.byId.get(id);
  }

  all(): ContextPage[] {
    return [...this.byId.values()];
  }
}

export class PageStore {
  private readonly sessionIndex = new Map<string, Promise<SessionPageIndex>>();

  constructor(
    readonly pagesRoot: string,
    readonly maxStorageBytes: number,
  ) {}

  sessionDir(sessionId: string): string {
    return join(this.pagesRoot, sessionId);
  }

  private pagePath(sessionId: string, pageId: string): string {
    return join(this.sessionDir(sessionId), `${pageId}.txt`);
  }

  private indexPath(sessionId: string): string {
    return join(this.sessionDir(sessionId), "index.jsonl");
  }

  private async loadIndex(sessionId: string): Promise<SessionPageIndex> {
    const cached = this.sessionIndex.get(sessionId);
    if (cached) return cached;
    const loading = (async () => {
      const raw = await readFile(this.indexPath(sessionId), "utf8").catch(
        () => "",
      );
      const pages: ContextPage[] = [];
      for (const line of raw.split("\n")) {
        if (line.length === 0) continue;
        try {
          pages.push(JSON.parse(line) as ContextPage);
        } catch {
          // skip corrupted index lines; page files are still readable by id
        }
      }
      return new SessionPageIndex(pages);
    })();
    this.sessionIndex.set(sessionId, loading);
    return loading;
  }

  /** Resolve a page metadata entry by id for the given session. */
  async getPage(
    sessionId: string,
    pageId: string,
  ): Promise<ContextPage | undefined> {
    const index = await this.loadIndex(sessionId);
    return index.lookup(pageId);
  }

  /** Exact dedupe lookup by normalized hash within the session (#16). */
  async lookupByNormalizedHash(
    sessionId: string,
    normalizedHash: string,
  ): Promise<ContextPage | undefined> {
    const index = await this.loadIndex(sessionId);
    return index.lookupByNormalizedHash(normalizedHash);
  }

  /** Read the exact raw page content (page file preserves original bytes). */
  async readRaw(page: ContextPage): Promise<string | undefined> {
    return readFile(page.storagePath, "utf8").catch(() => undefined);
  }

  /**
   * Persist a page (raw content + index line). On any failure returns
   * { ok: false } without throwing; the caller keeps the original output.
   */
  async writePage(
    sessionId: string,
    input: {
      page: Omit<ContextPage, "storagePath">;
      raw: string;
    },
  ): Promise<PageWriteResult> {
    try {
      const index = await this.loadIndex(sessionId);
      if (index.lookup(input.page.id)) {
        return {
          ok: true,
          page: {
            ...input.page,
            storagePath: this.pagePath(sessionId, input.page.id),
          },
          existed: true,
        };
      }
      const storagePath = this.pagePath(sessionId, input.page.id);
      await atomicWriteFile(storagePath, input.raw, { mode: PAGE_FILE_MODE });
      const page: ContextPage = { ...input.page, storagePath };
      await appendJsonlLine(this.indexPath(sessionId), page);
      // refresh in-memory index so the same hash dedupes immediately
      this.sessionIndex.delete(sessionId);
      return { ok: true, page, existed: false };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** All sessions with an index (used by /context-gc reports). */
  async listSessions(): Promise<string[]> {
    const entries = await readdir(this.pagesRoot, {
      withFileTypes: true,
    }).catch(() => [] as { name: string; isDirectory(): boolean }[]);
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  }

  /** Total page bytes across all sessions (approximate, best-effort). */
  async totalBytes(): Promise<number> {
    let total = 0;
    for (const sessionId of await this.listSessions()) {
      const index = await this.loadIndex(sessionId);
      for (const page of index.all()) total += page.rawBytes;
    }
    return total;
  }

  async sessionPages(sessionId: string): Promise<ContextPage[]> {
    const index = await this.loadIndex(sessionId);
    return index.all();
  }

  /** Conservative cleanup: remove pages of one session (explicit request only). */
  async removeSession(sessionId: string): Promise<boolean> {
    this.sessionIndex.delete(sessionId);
    return rm(this.sessionDir(sessionId), { recursive: true, force: true })
      .then(() => true)
      .catch(() => false);
  }

  static describe(page: ContextPage): string {
    return `page=${page.id} tool=${page.tool} raw=${formatBytes(page.rawBytes)} lines=${page.rawLines}`;
  }
}

/**
 * IEC byte formatting with a space before the unit ("305 KiB"). Shared by
 * the /context-gc UI and model-facing descriptor tags for consistent units.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb >= 100 ? kb.toFixed(0) : kb.toFixed(1)} KiB`;
  return `${(kb / 1024).toFixed(1)} MiB`;
}

export interface PageDraft {
  sessionId: string;
  callId: string;
  tool: string;
  argsHash: string;
  createdAt: number;
  title?: string;
  readOnly?: boolean;
  classification: PageCategory;
  /** exact raw output */
  raw: string;
  rawBytes: number;
  rawLines: number;
  rawSha256: string;
  normalizedSha256: string;
}

export function buildPage(draft: PageDraft): {
  page: Omit<ContextPage, "storagePath">;
  raw: string;
} {
  return {
    page: {
      id: pageIdOf(draft.sessionId, draft.callId, draft.rawSha256),
      sessionId: draft.sessionId,
      tool: draft.tool,
      callId: draft.callId,
      argsHash: draft.argsHash,
      createdAt: draft.createdAt,
      rawBytes: draft.rawBytes,
      rawLines: draft.rawLines,
      rawSha256: draft.rawSha256,
      normalizedSha256: draft.normalizedSha256,
      classification: draft.classification,
      title: draft.title,
      readOnly: draft.readOnly,
    },
    raw: draft.raw,
  };
}

export function analyzeRaw(
  raw: string,
  normalized: string,
): {
  rawBytes: number;
  rawLines: number;
  rawSha256: string;
  normalizedSha256: string;
} {
  return {
    rawBytes: countBytes(raw),
    rawLines: countLines(raw),
    rawSha256: sha256Hex(raw),
    normalizedSha256: sha256Hex(normalized),
  };
}

/** Create the pages root directory (permission 0700). */
export async function ensurePagesRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: DIR_MODE });
}
