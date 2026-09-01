/*
 * Exact dedupe unit tests (#16, #29). Verifies exact/safe-normalized
 * duplicate suppression and that distinct outputs always create their own
 * pages.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanupTemp, grepOutput, makeEngine, runProcess } from "./helpers";

afterEach(cleanupTemp);

describe("exact dedupe", () => {
  test("identical large output produces DEDUP_REF on the second call", async () => {
    const fixture = await makeEngine();
    const raw = grepOutput(1000);

    const first = await runProcess(fixture, {
      tool: "grep",
      readOnly: true,
      output: raw,
    });
    expect(first.changed).toBe(true);
    expect(first.disposition).toBe("PAGE");

    const second = await runProcess(fixture, {
      tool: "grep",
      readOnly: true,
      output: raw,
    });
    expect(second.changed).toBe(true);
    expect(second.disposition).toBe("DEDUP_REF");
    expect(second.output).toContain("[context-gc duplicate");

    const stats = await fixture.stats.snapshot("session-a");
    expect(stats.pagesCreated).toBe(1);
    expect(stats.duplicateHits).toBe(1);

    const pages = await fixture.pages.sessionPages("session-a");
    expect(pages).toHaveLength(1);
  });

  test("safe-normalized duplicates (CRLF / ANSI) also dedupe", async () => {
    const fixture = await makeEngine();
    const base = grepOutput(700);

    const first = await runProcess(fixture, {
      tool: "grep",
      readOnly: true,
      output: base,
    });
    expect(first.disposition).toBe("PAGE");

    const crlf = base.replace(/\n/g, "\r\n");
    const ansi = `\u001b[31m${base}\u001b[0m`;
    const second = await runProcess(fixture, {
      tool: "grep",
      readOnly: true,
      output: crlf,
    });
    expect(second.disposition).toBe("DEDUP_REF");

    const third = await runProcess(fixture, {
      tool: "grep",
      readOnly: true,
      output: ansi,
    });
    expect(third.disposition).toBe("DEDUP_REF");
  });

  test("distinct output always creates its own page", async () => {
    const fixture = await makeEngine();
    await runProcess(fixture, {
      tool: "grep",
      readOnly: true,
      output: grepOutput(500),
    });
    await runProcess(fixture, {
      tool: "grep",
      readOnly: true,
      output: grepOutput(510),
    });
    const stats = await fixture.stats.snapshot("session-a");
    expect(stats.pagesCreated).toBe(2);
    expect(stats.duplicateHits).toBe(0);
  });

  test("dedupe is per-session", async () => {
    const fixture = await makeEngine();
    const raw = grepOutput(600);
    await runProcess(fixture, {
      sessionId: "session-a",
      tool: "grep",
      readOnly: true,
      output: raw,
    });
    const second = await runProcess(fixture, {
      sessionId: "session-b",
      tool: "grep",
      readOnly: true,
      output: raw,
    });
    expect(second.disposition).toBe("PAGE");
  });

  test("exactDedup disabled keeps paging every occurrence", async () => {
    const fixture = await makeEngine({ exactDedup: false });
    const raw = grepOutput(600);
    await runProcess(fixture, { tool: "grep", readOnly: true, output: raw });
    const second = await runProcess(fixture, {
      tool: "grep",
      readOnly: true,
      output: raw,
    });
    expect(second.disposition).toBe("PAGE");
    expect(second.output).not.toContain("duplicate");
  });

  test("failure outputs are never deduped (evidence matters)", async () => {
    const fixture = await makeEngine();
    const raw = [
      "running tests...",
      "FAIL src/app.test.ts (1.2s)",
      "  AssertionError: expected 2 to equal 3",
      "  at src/app.test.ts:42:5",
    ].join("\n");
    const bigFail = `${raw}\n${grepOutput(1500)}`;

    const first = await runProcess(fixture, {
      tool: "bash",
      args: { command: "npm test" },
      output: bigFail,
    });
    expect(first.disposition).toBe("KEEP_CORE");
    const second = await runProcess(fixture, {
      tool: "bash",
      args: { command: "npm test" },
      output: bigFail,
    });
    expect(second.disposition).toBe("KEEP_CORE");
    expect(second.output).toContain("Failure core kept");

    const stats = await fixture.stats.snapshot("session-a");
    expect(stats.duplicateHits).toBe(0);
    expect(stats.pagesCreated).toBe(2);
  });
});
