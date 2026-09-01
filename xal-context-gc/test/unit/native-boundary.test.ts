/*
 * Native XAL output bounding interaction (#18, #29).
 *
 * XAL natively bounds only outputs above 50 KiB / 2,000 lines and does so
 * AFTER afterTool hooks. These tests pin down the boundary cases: outputs
 * below 50 KiB that XAL would pass through unmodified are paged by
 * context-gc, and failed writes never duplicate XAL's native path.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
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

afterEach(cleanupTemp);

describe("native boundary (#18)", () => {
  test("40 KiB test output is paged even though XAL's 50 KiB limit would not trigger", async () => {
    const fixture = await makeEngine();
    const raw = [
      "$ bun test",
      "bun test v1.1.0",
      ...fileOutput(800).split("\n"),
      "12 pass",
      "0 fail",
    ].join("\n");
    expect(countBytes(raw)).toBeGreaterThan(38 * 1024);
    expect(countBytes(raw)).toBeLessThan(50 * 1024);

    const result = await runProcess(fixture, {
      tool: "bash",
      args: { command: "bun test" },
      output: raw,
    });

    expect(result.changed).toBe(true);
    expect(result.disposition).toBe("PAGE");
    expect(countBytes(result.output!)).toBeLessThan(countBytes(raw));
  });

  test("35 KiB file read is paged (XAL native bounding would not run)", async () => {
    const fixture = await makeEngine();
    const raw = fileOutput(650);
    expect(countBytes(raw)).toBeGreaterThan(30 * 1024);
    expect(countBytes(raw)).toBeLessThan(50 * 1024);

    const result = await runProcess(fixture, {
      tool: "read",
      args: { path: "src/big.ts" },
      readOnly: true,
      output: raw,
    });

    expect(result.changed).toBe(true);
    expect(result.disposition).toBe("PAGE");
  });

  test("outputs left KEEP_RAW never create context-gc storage", async () => {
    const home = tempHome();
    const fixture = await makeEngine(home);
    await runProcess(fixture, { tool: "bash", output: fileOutput(20) });
    await runProcess(fixture, { tool: "edit", output: fileOutput(3000) });

    const sessions = await fixture.pages.listSessions();
    expect(sessions).toHaveLength(0);
  });

  test("page write failure bypasses storage and leaves output untouched", async () => {
    const home = tempHome();
    // occupy the pages directory with a file -> atomicWriteFile fails
    const pagesDir = join(home, "context-gc", "pages");
    mkdirSync(join(home, "context-gc"), { recursive: true });
    writeFileSync(pagesDir, "occupied", "utf8");

    const fixture = await makeEngine(home);
    const raw = grepOutput(1200);
    const result = await runProcess(fixture, {
      tool: "grep",
      readOnly: true,
      output: raw,
    });

    expect(result.changed).toBe(false);
  });

  test("descriptor output is far below the 50 KiB native limiter", async () => {
    const fixture = await makeEngine();
    const result = await runProcess(fixture, {
      tool: "read",
      args: { path: "src/huge.ts" },
      readOnly: true,
      output: fileOutput(2500),
    });
    expect(result.changed).toBe(true);
    expect(countBytes(result.output!)).toBeLessThan(50 * 1024);
    expect(countBytes(result.output!)).toBeLessThan(9 * 1024);
  });
});
