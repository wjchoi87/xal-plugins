/* Shared helpers: temp homes, engine factory and tool-call fixtures. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseContextGcConfig,
  type ResolvedContextGcConfig,
} from "../../config";
import { ContextGcEngine } from "../../gc/ingress";
import { PageStore } from "../../storage/page-store";
import { StatsStore } from "../../storage/stats-store";
import type { ToolExecutionContext } from "../../types";

const tempDirs: string[] = [];

export function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "context-gc-test-"));
  tempDirs.push(dir);
  return dir;
}

export function cleanupTemp(): void {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface EngineFixture {
  engine: ContextGcEngine;
  pages: PageStore;
  stats: StatsStore;
  resolved: ResolvedContextGcConfig;
  home: string;
}

export async function makeEngine(
  homeOrConfig?: string | Record<string, unknown>,
  configOverrides: Record<string, unknown> = {},
): Promise<EngineFixture> {
  const home = typeof homeOrConfig === "string" ? homeOrConfig : tempHome();
  const overrides =
    typeof homeOrConfig === "string" ? configOverrides : (homeOrConfig ?? {});
  const resolved = parseContextGcConfig(overrides);
  const pages = new PageStore(
    join(home, "context-gc", "pages"),
    resolved.config.maxStorageMb * 1024 * 1024,
  );
  const stats = new StatsStore(join(home, "context-gc", "stats"));
  const engine = new ContextGcEngine(resolved, pages, stats);
  return { engine, pages, stats, resolved, home };
}

export interface ProcessCallInput {
  sessionId?: string;
  callId?: string;
  tool?: string;
  args?: Record<string, unknown>;
  title?: string;
  readOnly?: boolean;
  output: string;
}

export async function runProcess(
  fixture: EngineFixture,
  input: ProcessCallInput,
) {
  return fixture.engine.process({
    sessionId: input.sessionId ?? "session-a",
    callId: input.callId ?? `call-${Math.random().toString(36).slice(2, 8)}`,
    tool: input.tool ?? "bash",
    args: input.args ?? {},
    title: input.title ?? input.tool ?? "tool",
    readOnly: input.readOnly ?? false,
    output: input.output,
  });
}

export function toolCtx(
  sessionId: string,
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return {
    cwd: "/tmp/project",
    sessionId,
    sessionKind: "primary",
    directory: "/tmp/project",
    signal: new AbortController().signal,
    update: () => undefined,
    ...overrides,
  };
}

/** Build a grep-like large output without any failure-looking words. */
export function grepOutput(lines = 900, content = "src/widget.ts"): string {
  const body: string[] = [];
  for (let index = 0; index < lines; index++) {
    body.push(`${content}:${index + 1}: match ${index + 1} of ${lines}`);
  }
  return body.join("\n");
}

/** Build a large file read with balanced content. */
export function fileOutput(lines = 1000): string {
  const body: string[] = [];
  for (let index = 0; index < lines; index++) {
    body.push(
      `    const value${index} = compute(${index}); // fixture line ${index + 1}`,
    );
  }
  return body.join("\n");
}
