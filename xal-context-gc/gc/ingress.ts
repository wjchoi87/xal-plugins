/*
 * Ingress GC engine (#4, #25 in INSTRUCTION.md).
 *
 * Runs inside the afterTool hook, BEFORE XAL's native boundToolOutput. If the
 * engine replaces an output, it has already persisted the exact raw content
 * itself — XAL will only ever see the compact form.
 *
 * Fail-open is absolute: every exception path returns { changed: false } so
 * the agent receives the untouched original output and the turn continues.
 */

import {
  analyzeOutput,
  type AnalyzeResult,
  type ContextDisposition,
} from "../analyzer/decide";
import { classifyTool } from "../analyzer/classify";
import { normalizeForDedup, countBytes } from "../analyzer/normalize";
import { extractFailureCore } from "../analyzer/failure-core";
import type { PageStore } from "../storage/page-store";
import { analyzeRaw, argsHashOf, buildPage } from "../storage/page-store";
import type { StatsStore } from "../storage/stats-store";
import { coreDescriptor, pageDescriptor } from "./descriptor";
import { findDuplicatePage, renderDuplicate } from "./dedupe";
import type { ResolvedContextGcConfig } from "../config";

export interface ProcessInput {
  sessionId: string;
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  title: string;
  readOnly: boolean;
  output: string;
}

export interface ProcessResult {
  changed: boolean;
  /** Replacement output when changed; otherwise the original. */
  output?: string;
  disposition?: ContextDisposition;
  /** Non-empty when the engine failed open (diagnostics only). */
  failOpen?: string;
}

export class ContextGcEngine {
  constructor(
    private readonly resolved: ResolvedContextGcConfig,
    private readonly pages: PageStore,
    private readonly stats: StatsStore,
  ) {}

  async process(input: ProcessInput): Promise<ProcessResult> {
    const sessionId = input.sessionId;
    try {
      const config = this.resolved.config;
      const normalized = normalizeForDedup(input.output, {
        stripAnsi: config.stripAnsi,
      });
      const hashes = analyzeRaw(input.output, normalized);

      await this.stats.note(sessionId, {
        outputsObserved: 1,
        observedBytes: hashes.rawBytes,
      });

      const decision = analyzeOutput(
        {
          tool: input.tool,
          args: input.args,
          title: input.title,
          readOnly: input.readOnly,
          output: input.output,
        },
        this.resolved,
      );

      if (!decision || decision.disposition === "KEEP_RAW") {
        await this.stats.note(sessionId, { outputsKeptRaw: 1 });
        return {
          changed: false,
          disposition: decision ? decision.disposition : "DEFER",
        };
      }

      // Exact dedupe for plain pages only. Failure cores are intentionally
      // never collapsed: the repetition itself is behavioral evidence (#17).
      if (
        decision.disposition === "PAGE" &&
        config.exactDedup &&
        hashes.rawBytes >= this.resolved.thresholds.generic
      ) {
        const existing = await findDuplicatePage(
          this.pages,
          sessionId,
          hashes.normalizedSha256,
        );
        if (existing) {
          const emitted = renderDuplicate(existing);
          await this.stats.note(sessionId, {
            outputsPaged: 1,
            duplicateHits: 1,
            emittedBytes: countBytes(emitted),
            reclaimedBytes: Math.max(0, hashes.rawBytes - countBytes(emitted)),
          });
          return { changed: true, output: emitted, disposition: "DEDUP_REF" };
        }
      }

      const page = buildPage({
        sessionId,
        callId: input.callId,
        tool: input.tool,
        argsHash: argsHashOf(input.args),
        createdAt: Date.now(),
        title: input.title,
        readOnly: input.readOnly,
        classification: decision.category,
        raw: input.output,
        rawBytes: hashes.rawBytes,
        rawLines: hashes.rawLines,
        rawSha256: hashes.rawSha256,
        normalizedSha256: hashes.normalizedSha256,
      });

      const write = await this.pages.writePage(sessionId, page);
      if (!write.ok) {
        // Persistence failure -> pass the original untouched (#11, #18).
        await this.stats.note(sessionId, {
          storeFailures: 1,
          outputsKeptRaw: 1,
        });
        return {
          changed: false,
          disposition: "KEEP_RAW",
          failOpen: "page store failure",
        };
      }

      const emitted =
        decision.disposition === "KEEP_CORE"
          ? coreDescriptor(
              write.page,
              extractFailureCore(input.output, decision.family),
            )
          : pageDescriptor(write.page, input.output, {
              previewBytes: config.previewBytes,
            });

      await this.stats.note(sessionId, {
        outputsPaged: 1,
        pagesCreated: write.existed ? 0 : 1,
        emittedBytes: countBytes(emitted),
        reclaimedBytes: Math.max(0, hashes.rawBytes - countBytes(emitted)),
      });

      return {
        changed: true,
        output: emitted,
        disposition: decision.disposition,
      };
    } catch (error) {
      // Fail open: agent must receive the untouched original (#25, #28).
      await this.stats
        .note(sessionId, { failOpenCount: 1 })
        .catch(() => undefined);
      return {
        changed: false,
        failOpen: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

/** Small exported helper so tests can inspect family classification. */
export function familyOf(
  tool: string,
  args: Record<string, unknown>,
  title: string,
) {
  return classifyTool(tool, args, title).family;
}

export type { AnalyzeResult };
