/*
 * Ingress GC unit tests (#28, #29). Covers paging decisions, native-boundary
 * interaction and fail-open behavior of the afterTool engine.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTemp,
  fileOutput,
  grepOutput,
  makeEngine,
  runProcess,
  tempHome,
} from "./helpers";
import { countBytes } from "../../analyzer/normalize";
import { pageDescriptorTag } from "../../gc/descriptor";

afterEach(cleanupTemp);

describe("ingress paging decisions", () => {
  test("40 KiB grep output is paged below the descriptor target", async () => {
    const fixture = await makeEngine();
    const raw = grepOutput(1200);
    expect(countBytes(raw)).toBeGreaterThan(38 * 1024);
    expect(countBytes(raw)).toBeLessThan(50 * 1024); // below XAL native 50 KiB

    const result = await runProcess(fixture, {
      tool: "grep",
      args: { query: "match", path: "src" },
      readOnly: true,
      output: raw,
    });

    expect(result.changed).toBe(true);
    expect(result.output).toContain("[context-gc page=");
    // descriptor target: 1-4 KiB for plain pages
    expect(countBytes(result.output!)).toBeLessThan(8192);
    expect(result.disposition).toBe("PAGE");

    const stats = await fixture.stats.snapshot("session-a");
    expect(stats.outputsPaged).toBe(1);
    expect(stats.reclaimedBytes).toBeGreaterThan(30 * 1024);
  });

  test("200 KiB output is paged before XAL native bounding", async () => {
    const fixture = await makeEngine();
    const raw = grepOutput(6000);
    expect(countBytes(raw)).toBeGreaterThan(190 * 1024);

    const result = await runProcess(fixture, {
      tool: "search",
      readOnly: true,
      output: raw,
    });

    expect(result.changed).toBe(true);
    expect(countBytes(result.output!)).toBeLessThan(8192);
  });

  test("small tool result remains unchanged", async () => {
    const fixture = await makeEngine();
    const output = "ok";
    const result = await runProcess(fixture, { tool: "bash", output });
    expect(result.changed).toBe(false);
    expect(result.output).toBeUndefined();
  });

  test("explicit narrow file read is kept raw even when large", async () => {
    const fixture = await makeEngine();
    const result = await runProcess(fixture, {
      tool: "read",
      args: { path: "src/app.ts", start_line: 1, end_line: 120 },
      readOnly: true,
      output: fileOutput(2000),
    });
    expect(result.changed).toBe(false);
  });

  test("large file read is paged with path metadata", async () => {
    const fixture = await makeEngine();
    const result = await runProcess(fixture, {
      tool: "read",
      args: { path: "src/huge.ts" },
      readOnly: true,
      output: fileOutput(1500),
    });
    expect(result.changed).toBe(true);
    const pages = await fixture.pages.sessionPages("session-a");
    expect(pages).toHaveLength(1);
    expect(pages[0]!.classification).toBe("file");
  });

  test("write tool output stays in context regardless of size", async () => {
    const fixture = await makeEngine();
    const raw = fileOutput(5000);
    const result = await runProcess(fixture, {
      tool: "edit",
      args: { path: "src/app.ts" },
      output: raw,
    });
    expect(result.changed).toBe(false);
  });

  test("recall tool output is never paged", async () => {
    const fixture = await makeEngine();
    const raw = fileOutput(3000);
    const result = await runProcess(fixture, {
      tool: "context_gc_recall",
      args: { page_id: "abc123" },
      readOnly: true,
      output: raw,
    });
    expect(result.changed).toBe(false);
  });

  test("empty output is kept raw", async () => {
    const fixture = await makeEngine();
    const result = await runProcess(fixture, { tool: "bash", output: "" });
    expect(result.changed).toBe(false);
  });

  test("unknown tool large output is preserved in conservative mode", async () => {
    const fixture = await makeEngine();
    const raw = fileOutput(3000);
    const result = await runProcess(fixture, {
      tool: "mystery_tool",
      output: raw,
    });
    expect(result.changed).toBe(false);
  });
});

describe("storage failure fail-open (#11, #29-E)", () => {
  test("page write failure passes the original output unchanged", async () => {
    const home = tempHome();
    // Make the pages directory un-creatable: a file occupies its path.
    mkdirSync(join(home, "context-gc"), { recursive: true });
    const pagesPath = join(home, "context-gc", "pages");
    writeFileSync(pagesPath, "not a directory", "utf8");

    const fixture = await makeEngine(home);
    const raw = grepOutput(1200);
    const result = await runProcess(fixture, {
      tool: "grep",
      readOnly: true,
      output: raw,
    });

    expect(result.changed).toBe(false);
    expect(result.failOpen).toBeTruthy();
    const stats = await fixture.stats.snapshot("session-a");
    expect(stats.storeFailures).toBe(1);
    expect(stats.outputsKeptRaw).toBe(1);
  });

  test("engine exception fails open without touching the output", async () => {
    const fixture = await makeEngine();
    const raw = grepOutput(1200);
    // Force an engine-internal exception: circular args break JSON hashing.
    const circular = {} as Record<string, unknown>;
    circular.self = circular;
    const result = await runProcess(fixture, {
      tool: "grep",
      args: circular,
      readOnly: true,
      output: raw,
    });
    expect(result.changed).toBe(false);
    expect(result.failOpen).toBeTruthy();
  });
});

describe("native boundary interaction (#18)", () => {
  test("KEEP_RAW never creates a context-gc page (XAL bounds later)", async () => {
    const fixture = await makeEngine();
    await runProcess(fixture, { tool: "bash", output: "small" });
    await runProcess(fixture, {
      tool: "read",
      args: { start_line: 1, end_line: 50 },
      output: fileOutput(60),
    });
    const pages = await fixture.pages.sessionPages("session-a");
    expect(pages).toHaveLength(0);
  });

  test("paged descriptor instantly becomes the XAL-visible output", async () => {
    const fixture = await makeEngine();
    const result = await runProcess(fixture, {
      tool: "grep",
      readOnly: true,
      output: grepOutput(2000),
    });
    expect(result.changed).toBe(true);
    // the replacement must be a string XAL's boundToolOutput can consume
    expect(typeof result.output).toBe("string");
    expect(pageDescriptorTag).toBeDefined();
  });
});

describe("ingress fidelity (#28)", () => {
  test("exact page storage is byte-consistent for UTF-8 content", async () => {
    const fixture = await makeEngine({ filePageThresholdBytes: 64 });
    const raw = [
      "// 한글 주석 포함 파일",
      "const emoji = '🎉🚀';",
      "const café = 42; // ünïcödé",
      "x = '日本語テスト'",
      ...fileOutput(60).split("\n"),
    ].join("\n");
    const result = await runProcess(fixture, {
      tool: "read",
      args: { path: "src/utf.ts" },
      readOnly: true,
      output: raw,
    });
    expect(result.changed).toBe(true);

    const pages = await fixture.pages.sessionPages("session-a");
    const stored = await fixture.pages.readRaw(pages[0]!);
    expect(stored).toBe(raw);
    expect(countBytes(stored!)).toBe(countBytes(raw));
  });
});

describe("statistics recording", () => {
  test("observed/kept/paged counters stay consistent", async () => {
    const fixture = await makeEngine();
    await runProcess(fixture, { tool: "bash", output: "tiny" });
    await runProcess(fixture, {
      tool: "grep",
      readOnly: true,
      output: grepOutput(1000),
    });
    const stats = await fixture.stats.snapshot("session-a");
    expect(stats.outputsObserved).toBe(2);
    expect(stats.outputsKeptRaw).toBe(1);
    expect(stats.outputsPaged).toBe(1);
    expect(stats.pagesCreated).toBe(1);
    expect(stats.emittedBytes).toBeGreaterThan(0);
    expect(stats.reclaimedBytes).toBeGreaterThan(0);
  });

  test("stats file exists on disk after processing", async () => {
    const fixture = await makeEngine();
    await runProcess(fixture, { tool: "bash", output: "x" });
    expect(existsSync(fixture.stats.statsPath("session-a"))).toBe(true);
  });
});
