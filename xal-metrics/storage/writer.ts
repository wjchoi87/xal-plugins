/*
 * JSONL persistence (#29–33).
 *
 * One line per completed turn, appended at turn end only — never during the
 * stream (#41). File lives under the XAL plugin data directory
 * (~/.xal/metrics/metrics.jsonl) mirroring XAL's own JSONL usage recorder.
 *
 * Retention (#32): when the file exceeds the size cap the oldest quarter of
 * lines is trimmed. Privacy (#33): only timing/usage metadata is stored,
 * never prompts, responses, tool payloads or credentials.
 */

import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { cacheCoverage } from "../metrics/usage";
import {
  firstEventLatencyMs,
  firstReasoningLatencyMs,
  firstTextLatencyMs,
  maxStallMs,
  totalStallMs,
  tokensPerSecond,
} from "../metrics/stream";
import type { CompletedTurn } from "../metrics/collector";

export const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const TRIM_FRACTION = 0.25;

export interface StoredTurn {
  sessionId: string;
  provider: string;
  model: string;
  startedAt?: number;
  completedAt?: number;
  firstEventLatencyMs?: number;
  firstReasoningLatencyMs?: number;
  firstTextLatencyMs?: number;
  generationDurationMs?: number;
  turnDurationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheHitRate?: number;
  toolCount?: number;
  toolDurationMs?: number;
  stallCount?: number;
  maxStallMs?: number;
  totalStallMs?: number;
  tps?: number;
}

/** Missing values stay omitted (undefined), never coerced to 0 (#30). */
export function toStoredTurn(turn: CompletedTurn): StoredTurn {
  const turnDurationMs =
    turn.completedAt !== undefined && turn.startedAt !== undefined
      ? turn.completedAt - turn.startedAt
      : undefined;
  const maxStall = maxStallMs(turn);
  const totalStall = totalStallMs(turn);
  const coverage = cacheCoverage(turn);
  return {
    sessionId: turn.sessionId,
    provider: turn.provider,
    model: turn.model,
    startedAt: turn.wallStartedAt,
    completedAt: turn.wallCompletedAt,
    firstEventLatencyMs: firstEventLatencyMs(turn),
    firstReasoningLatencyMs: firstReasoningLatencyMs(turn),
    firstTextLatencyMs: firstTextLatencyMs(turn),
    generationDurationMs: turn.generationMs,
    turnDurationMs,
    ...(turn.totalInputTokens !== undefined
      ? { inputTokens: turn.totalInputTokens }
      : {}),
    ...(turn.outputTokens !== undefined
      ? { outputTokens: turn.outputTokens }
      : {}),
    ...(turn.cacheReadTokens !== undefined
      ? { cacheReadTokens: turn.cacheReadTokens }
      : {}),
    ...(turn.cacheWriteTokens !== undefined
      ? { cacheWriteTokens: turn.cacheWriteTokens }
      : {}),
    ...(coverage !== undefined
      ? { cacheHitRate: Number(coverage.toFixed(4)) }
      : {}),
    ...(turn.toolCount > 0 ? { toolCount: turn.toolCount } : {}),
    ...(turn.toolDurationMs > 0 ? { toolDurationMs: turn.toolDurationMs } : {}),
    ...(turn.stalls.length > 0 ? { stallCount: turn.stalls.length } : {}),
    ...(maxStall !== undefined ? { maxStallMs: maxStall } : {}),
    ...(totalStall !== undefined ? { totalStallMs: totalStall } : {}),
    ...(tokensPerSecond(turn) !== undefined
      ? { tps: Number(tokensPerSecond(turn)!.toFixed(2)) }
      : {}),
  };
}

export class MetricsWriter {
  readonly path: string;
  private readonly maxBytes: number;
  private chain: Promise<void> = Promise.resolve();

  constructor(path: string, maxBytes = DEFAULT_MAX_FILE_BYTES) {
    this.path = path;
    this.maxBytes = maxBytes;
  }

  /**
   * Storage failures never surface into the agent turn (#43): swallowed here.
   * Appends and retention trims are serialized on one promise chain so a
   * concurrent turn end (e.g. primary + subagent sessions) can never have a
   * trim's read-modify-write overwrite a line appended by another turn.
   */
  append(turn: CompletedTurn): Promise<void> {
    const run = this.chain.then(async () => {
      try {
        await mkdir(dirname(this.path), { recursive: true });
        await appendFile(this.path, `${JSON.stringify(toStoredTurn(turn))}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        await this.trimIfNeeded();
      } catch {
        // metrics write failure only drops the metric line
      }
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async trimIfNeeded(): Promise<void> {
    const info = await stat(this.path).catch(() => undefined);
    if (!info || info.size <= this.maxBytes) return;
    const content = await readFile(this.path, "utf8").catch(() => undefined);
    if (content === undefined) return;
    const lines = content.split("\n").filter((line) => line.length > 0);
    const keep = Math.max(
      1,
      lines.length - Math.ceil(lines.length * TRIM_FRACTION),
    );
    const trimmed = lines.slice(lines.length - keep).join("\n") + "\n";
    await writeFile(this.path, trimmed, { encoding: "utf8", mode: 0o600 });
  }
}
