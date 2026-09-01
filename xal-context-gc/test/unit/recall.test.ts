/*
 * Recall tool unit tests (#14, #28). Verifies exact line-range and literal
 * query retrieval, hard output bounds and cross-restart persistence.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createRecallTool } from "../../tools/recall";
import { PageStore } from "../../storage/page-store";
import { StatsStore } from "../../storage/stats-store";
import { countBytes } from "../../analyzer/normalize";
import {
  cleanupTemp,
  fileOutput,
  grepOutput,
  makeEngine,
  runProcess,
  toolCtx,
} from "./helpers";

afterEach(cleanupTemp);

/** Build a paged output and return its page id. */
async function pageFor(
  fixture: Awaited<ReturnType<typeof makeEngine>>,
  output: string,
): Promise<string> {
  await runProcess(fixture, {
    tool: "read",
    args: { path: "src/fixture.txt" },
    readOnly: true,
    output,
  });
  const pages = await fixture.pages.sessionPages("session-a");
  if (pages.length === 0) throw new Error("expected a page to exist");
  return pages[pages.length - 1]!.id;
}

describe("line-range recall", () => {
  test("returns exact original lines for a bounded range", async () => {
    const fixture = await makeEngine({
      filePageThresholdBytes: 1,
      searchPageThresholdBytes: 1,
      commandPageThresholdBytes: 1,
    });
    const raw = [
      "zero",
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
      "eight",
      "nine",
      ...fileOutput(30).split("\n"),
    ].join("\n");
    const pageId = await pageFor(fixture, raw);

    const tool = createRecallTool(
      fixture.pages,
      fixture.stats,
      fixture.resolved.config,
    );
    const result = await tool.execute(
      { page_id: pageId, start_line: 2, end_line: 5 },
      toolCtx("session-a"),
    );
    expect(result.output).toContain("[context-gc recall");
    expect(result.output).toContain("one\ntwo\nthree\nfour");
    expect(result.output).not.toContain("zero\n");
    expect(result.output).not.toContain("seven");
  });

  test("line numbers are 1-based and inclusive", async () => {
    const fixture = await makeEngine({
      filePageThresholdBytes: 1,
      searchPageThresholdBytes: 1,
      commandPageThresholdBytes: 1,
    });
    const raw = ["a", "b", "c", "d", "e"].join("\n");
    const pageId = await pageFor(fixture, raw);
    const tool = createRecallTool(
      fixture.pages,
      fixture.stats,
      fixture.resolved.config,
    );
    const result = await tool.execute(
      { page_id: pageId, start_line: 3, end_line: 3 },
      toolCtx("session-a"),
    );
    expect(result.output).toContain("lines=3-3");
    expect(result.output).toMatch(/\nc\n?$/);
  });

  test("clamps out-of-bound ranges to the page size", async () => {
    const fixture = await makeEngine({
      filePageThresholdBytes: 1,
      searchPageThresholdBytes: 1,
      commandPageThresholdBytes: 1,
    });
    const raw = ["a", "b", "c"].join("\n");
    const pageId = await pageFor(fixture, raw);
    const tool = createRecallTool(
      fixture.pages,
      fixture.stats,
      fixture.resolved.config,
    );
    const result = await tool.execute(
      { page_id: pageId, start_line: 2, end_line: 999 },
      toolCtx("session-a"),
    );
    expect(result.output).toContain("b\nc");
    expect(result.output).not.toContain("truncated");
  });
});

describe("literal query recall", () => {
  test("returns exact matching lines with line numbers", async () => {
    const fixture = await makeEngine({
      filePageThresholdBytes: 1,
      searchPageThresholdBytes: 1,
      commandPageThresholdBytes: 1,
    });
    const raw = [
      "alpha one",
      "beta two",
      "gamma one",
      "delta three",
      "epsilon one",
    ].join("\n");
    const pageId = await pageFor(fixture, raw);
    const tool = createRecallTool(
      fixture.pages,
      fixture.stats,
      fixture.resolved.config,
    );
    const result = await tool.execute(
      { page_id: pageId, query: "one", context_lines: 0 },
      toolCtx("session-a"),
    );
    expect(result.output).toContain("1 | alpha one");
    expect(result.output).toContain("3 | gamma one");
    expect(result.output).toContain("5 | epsilon one");
    expect(result.output).not.toContain("beta two");
  });

  test("query is case-sensitive literal", async () => {
    const fixture = await makeEngine({
      filePageThresholdBytes: 1,
      searchPageThresholdBytes: 1,
      commandPageThresholdBytes: 1,
    });
    const raw = "Find FOO\nfind foo\nFind foo\n".trim();
    const pageId = await pageFor(fixture, raw);
    const tool = createRecallTool(
      fixture.pages,
      fixture.stats,
      fixture.resolved.config,
    );
    const result = await tool.execute(
      { page_id: pageId, query: "Foo" },
      toolCtx("session-a"),
    );
    expect(result.output).not.toContain("|");
  });

  test("context_lines includes bounded neighbors", async () => {
    const fixture = await makeEngine({
      filePageThresholdBytes: 1,
      searchPageThresholdBytes: 1,
      commandPageThresholdBytes: 1,
    });
    const raw = ["a", "b", "TARGET", "d", "e", "f"].join("\n");
    const pageId = await pageFor(fixture, raw);
    const tool = createRecallTool(
      fixture.pages,
      fixture.stats,
      fixture.resolved.config,
    );
    const result = await tool.execute(
      { page_id: pageId, query: "TARGET", context_lines: 1 },
      toolCtx("session-a"),
    );
    expect(result.output).toContain("2 | b");
    expect(result.output).toContain("4 | d");
    expect(result.output).not.toContain("1 | a");
    expect(result.output).not.toContain("5 | e");
  });
});

describe("bounds", () => {
  test("never allows an unlimited dump", async () => {
    const fixture = await makeEngine({
      filePageThresholdBytes: 1,
      searchPageThresholdBytes: 1,
      commandPageThresholdBytes: 1,
    });
    const raw = fileOutput(2000);
    const pageId = await pageFor(fixture, raw);
    const tool = createRecallTool(
      fixture.pages,
      fixture.stats,
      fixture.resolved.config,
    );

    // no limits at all: still bounded by recallDefaultBytes
    const result = await tool.execute(
      { page_id: pageId },
      toolCtx("session-a"),
    );
    expect(countBytes(result.output)).toBeLessThanOrEqual(14 * 1024);

    // explicit max_bytes above hard cap is clamped to recallMaxBytes
    const huge = await tool.execute(
      { page_id: pageId, max_bytes: 1024 * 1024 },
      toolCtx("session-a"),
    );
    expect(countBytes(huge.output)).toBeLessThanOrEqual(34 * 1024);
    expect(huge.output).toContain(
      "[truncated; request another range if needed]",
    );
  });

  test("reports a continuation hint when truncated", async () => {
    const fixture = await makeEngine({
      filePageThresholdBytes: 1,
      searchPageThresholdBytes: 1,
      commandPageThresholdBytes: 1,
    });
    const raw = fileOutput(300);
    const pageId = await pageFor(fixture, raw);
    const tool = createRecallTool(
      fixture.pages,
      fixture.stats,
      fixture.resolved.config,
    );
    const result = await tool.execute(
      { page_id: pageId, start_line: 1, end_line: 300, max_bytes: 1024 },
      toolCtx("session-a"),
    );
    expect(result.output).toContain(
      "[truncated; request another range if needed]",
    );
  });
});

describe("error paths", () => {
  test("missing page_id returns usage instead of failing", async () => {
    const fixture = await makeEngine({
      filePageThresholdBytes: 1,
      searchPageThresholdBytes: 1,
      commandPageThresholdBytes: 1,
    });
    const tool = createRecallTool(
      fixture.pages,
      fixture.stats,
      fixture.resolved.config,
    );
    const result = await tool.execute({}, toolCtx("session-a"));
    expect(result.output).toContain("usage:");
  });

  test("unknown page id returns a message, not a throw", async () => {
    const fixture = await makeEngine({
      filePageThresholdBytes: 1,
      searchPageThresholdBytes: 1,
      commandPageThresholdBytes: 1,
    });
    const tool = createRecallTool(
      fixture.pages,
      fixture.stats,
      fixture.resolved.config,
    );
    const result = await tool.execute(
      { page_id: "deadbeef00000000" },
      toolCtx("session-a"),
    );
    expect(result.output).toContain("page not found");
  });

  test("failed recall never crashes the agent", async () => {
    const fixture = await makeEngine({
      filePageThresholdBytes: 1,
      searchPageThresholdBytes: 1,
      commandPageThresholdBytes: 1,
    });
    const tool = createRecallTool(
      fixture.pages,
      fixture.stats,
      fixture.resolved.config,
    );
    const result = await Promise.resolve(
      tool.execute({ page_id: "nope" }, toolCtx("session-a")),
    );
    expect(typeof result.output).toBe("string");
  });
});

describe("restart persistence (#31-D)", () => {
  test("a fresh PageStore can recall a page written by a previous one", async () => {
    const fixture = await makeEngine({
      filePageThresholdBytes: 1,
      searchPageThresholdBytes: 1,
      commandPageThresholdBytes: 1,
    });
    const raw = grepOutput(1200);
    const pageId = await pageFor(fixture, raw);

    // simulate XAL restart: brand new store instances over the same root
    const pages = new PageStore(
      join(fixture.home, "context-gc", "pages"),
      fixture.resolved.config.maxStorageMb * 1024 * 1024,
    );
    const stats = new StatsStore(join(fixture.home, "context-gc", "stats"));
    const tool = createRecallTool(pages, stats, fixture.resolved.config);

    const result = await tool.execute(
      { page_id: pageId, start_line: 1, end_line: 3 },
      toolCtx("session-a"),
    );
    expect(result.output).toContain("match 1");
    expect(result.output).toContain("match 3");

    const stored = await pages.getPage("session-a", pageId);
    const rawAgain = await pages.readRaw(stored!);
    expect(rawAgain).toBe(raw);
  });
});
