/*
 * Failure-memory unit tests (#17, #28). Verifies that actionable failure
 * evidence stays in context while the full log is paged, and that success
 * noise never gets a "failure core".
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanupTemp, fileOutput, makeEngine, runProcess } from "./helpers";
import { countBytes } from "../../analyzer/normalize";

function failingTestLog(padding = fileOutput(1400)): string {
  return [
    "$ npm test",
    "",
    "> app@1.0.0 test",
    "> vitest run",
    "",
    " RUN  v2.1.9 /Users/me/app",
    "",
    "src/app.test.ts:",
    "  ❯ adds numbers fails (42ms)",
    "    ✗ adds numbers",
    "      AssertionError: expected 2 to equal 3",
    "",
    '      - Expected  "3"',
    '      + Received "2"',
    "",
    "      at src/app.test.ts:42:5:32",
    "      at src/app.test.ts:44:7",
    "      at src/calc.ts:101",
    "",
    " Test Files  1 failed | 1 passed (2)",
    "      Tests  1 failed | 3 passed (4)",
    "   Duration  128ms",
    padding,
  ].join("\n");
}

function passingTestLog(padding = fileOutput(1400)): string {
  return [
    "$ npm test",
    "> vitest run",
    " Test Files  4 passed (4)",
    "      Tests  12 passed (12)",
    "   Duration  96ms",
    padding,
  ].join("\n");
}

afterEach(cleanupTemp);

describe("failure-core preservation (#17)", () => {
  test("failed test log keeps actionable core and pages the raw log", async () => {
    const fixture = await makeEngine();
    const raw = failingTestLog();
    expect(countBytes(raw)).toBeGreaterThan(40 * 1024);

    const result = await runProcess(fixture, {
      tool: "bash",
      args: { command: "npm test" },
      output: raw,
    });

    expect(result.changed).toBe(true);
    expect(result.disposition).toBe("KEEP_CORE");
    const output = result.output!;
    expect(output).toContain("[context-gc page=");
    expect(output).toContain("Failure core kept in context");
    // core carries the failing test identifier + exact diagnostics
    expect(output).toContain("adds numbers");
    expect(output).toContain("AssertionError");
    expect(output).toContain("src/app.test.ts:42:5:32");
    // core stays bounded (~8 KiB target)
    expect(countBytes(output)).toBeLessThanOrEqual(9 * 1024);

    // full raw log is recoverable
    const pages = await fixture.pages.sessionPages("session-a");
    expect(pages).toHaveLength(1);
    expect(pages[0]!.classification).toBe("error");
    const stored = await fixture.pages.readRaw(pages[0]!);
    expect(stored).toBe(raw);
  });

  test("success noise is paged without any failure core", async () => {
    const fixture = await makeEngine();
    const result = await runProcess(fixture, {
      tool: "bash",
      args: { command: "npm test" },
      output: passingTestLog(),
    });

    expect(result.changed).toBe(true);
    expect(result.disposition).toBe("PAGE");
    expect(result.output).not.toContain("Failure core");
    expect(result.output).not.toContain("AssertionError");
  });

  test("failure core includes bounded neighboring lines", async () => {
    const fixture = await makeEngine();
    const raw = [
      `line-1 ${fileOutput(2000)}`,
      "line-2 context before",
      "line-3 AssertionError: boom",
      "line-4 context after",
      "END",
    ].join("\n");
    const result = await runProcess(fixture, {
      tool: "bash",
      args: { command: "pytest" },
      output: raw,
    });
    expect(result.disposition).toBe("KEEP_CORE");
    expect(result.output).toContain("line-2 context before");
    expect(result.output).toContain("line-4 context after");
  });

  test("a lone ambiguous error word does not trigger failure core", async () => {
    const fixture = await makeEngine();
    // grep-style output listing many code lines containing "error" as a word
    const raw = [
      "src/a.ts:10: handleError(user)",
      "src/b.ts:20: errorManager.report()",
      ...fileOutput(800).split("\n"),
    ].join("\n");
    const result = await runProcess(fixture, {
      tool: "grep",
      readOnly: true,
      output: raw,
    });
    expect(result.disposition).toBe("PAGE");
    expect(result.output).not.toContain("Failure core");
  });

  test("success counters neutralize failure detection", async () => {
    const fixture = await makeEngine();
    const raw = [
      "$ npm test",
      "0 failed, 12 passed",
      ...fileOutput(900).split("\n"),
    ].join("\n");
    const result = await runProcess(fixture, {
      tool: "bash",
      args: { command: "npm test" },
      output: raw,
    });
    expect(result.disposition).toBe("PAGE");
    expect(result.output).not.toContain("Failure core");
  });
});
