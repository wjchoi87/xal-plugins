/*
 * /context-gc command UI tests.
 *
 * The basic summary must answer "how much context inflow did GC prevent?"
 * without the ambiguous emitted counter, and without zero-value noise:
 *   - emitted (modified-outputs-only bytes) is hidden from the summary
 *   - reclaimed ratio = reclaimedBytes / observedBytes (byte metric, not
 *     token savings)
 *   - IEC units rendered with a space: "305 KiB"
 *   - dedup / fail-open lines appear only when > 0
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { contextGcCommand } from "../../commands";
import { PageStore } from "../../storage/page-store";
import { StatsStore } from "../../storage/stats-store";
import type { CommandContext } from "../../types";
import { cleanupTemp, tempHome } from "./helpers";

async function makeFixture() {
  const home = tempHome();
  const stats = new StatsStore(join(home, "context-gc", "stats"));
  const pages = new PageStore(join(home, "context-gc", "pages"), 1024 * 1024);
  return { stats, pages };
}

function harness() {
  const lines: string[] = [];
  const ctx = {
    session: { id: "session-a" },
    print: (line: string) => void lines.push(line),
    busy: () => undefined,
    restore: () => undefined,
    ask: async () => undefined,
    askSecret: async () => undefined,
  } as unknown as CommandContext;
  return { ctx, lines };
}

afterEach(cleanupTemp);

describe("/context-gc summary", () => {
  test("hides emitted from the basic output", async () => {
    const { stats, pages } = await makeFixture();
    await stats.note("session-a", {
      observedBytes: 312_320,
      emittedBytes: 12_800,
      reclaimedBytes: 58_470,
      outputsPaged: 3,
      outputsKeptRaw: 60,
    });
    const { ctx, lines } = harness();
    await contextGcCommand(stats, pages).run([], ctx);

    expect(lines.join("\n")).not.toContain("emitted");
  });

  test("shows observed and reclaimed with correct IEC spacing and ratio", async () => {
    const { stats, pages } = await makeFixture();
    // 312320 B = 305 KiB; 58470 B = 57.1 KiB; 58470/312320 = 18.72%
    await stats.note("session-a", {
      observedBytes: 312_320,
      reclaimedBytes: 58_470,
    });
    const { lines } = await runSummary(stats, pages);

    expect(lines[2]).toBe("observed     305 KiB");
    expect(lines[3]).toBe("reclaimed    57.1 KiB (18.7%)");
  });

  test("never renders units without a space (305KiB style)", async () => {
    const { stats, pages } = await makeFixture();
    await stats.note("session-a", {
      observedBytes: 312_320,
      reclaimedBytes: 58_470,
    });
    const { lines } = await runSummary(stats, pages);
    const output = lines.join("\n");
    expect(output).toContain("305 KiB");
    expect(output).not.toMatch(/\d+(?:\.\d+)?KiB/);
    expect(output).not.toMatch(/\d+(?:\.\d+)?MiB/);
  });

  test("ratio is exactly reclaimedBytes / observedBytes (byte metric)", async () => {
    const { stats, pages } = await makeFixture();
    await stats.note("session-a", {
      observedBytes: 100_000,
      reclaimedBytes: 50_000,
    });
    const { lines } = await runSummary(stats, pages);
    expect(lines[3]).toBe("reclaimed    48.8 KiB (50.0%)");
  });

  test("ratio is 0.0% when nothing was observed", async () => {
    const { stats, pages } = await makeFixture();
    const { lines } = await runSummary(stats, pages);
    expect(lines[3]).toBe("reclaimed    0 B (0.0%)");
  });

  test("hides dedup and fail-open when zero", async () => {
    const { stats, pages } = await makeFixture();
    await stats.note("session-a", { outputsPaged: 1, outputsKeptRaw: 5 });
    const { lines } = await runSummary(stats, pages);
    const output = lines.join("\n");
    expect(output).not.toContain("dedup");
    expect(output).not.toContain("fail-open");
  });

  test("shows dedup and fail-open when non-zero", async () => {
    const { stats, pages } = await makeFixture();
    await stats.note("session-a", {
      outputsPaged: 3,
      outputsKeptRaw: 60,
      duplicateHits: 2,
      failOpenCount: 1,
    });
    const { lines } = await runSummary(stats, pages);
    const output = lines.join("\n");
    expect(output).toContain("dedup        2");
    expect(output).toContain("fail-open    1");
  });

  test("keeps recalls visible even at zero", async () => {
    const { stats, pages } = await makeFixture();
    await stats.note("session-a", { outputsPaged: 1 });
    const { lines } = await runSummary(stats, pages);
    expect(lines).toContain("recalls      0");
  });

  test("groups bytes and counts with blank separators", async () => {
    const { stats, pages } = await makeFixture();
    await stats.note("session-a", { observedBytes: 1024, reclaimedBytes: 512 });
    const { lines } = await runSummary(stats, pages);
    expect(lines[0]).toBe("Context GC");
    expect(lines[1]).toBe("");
    expect(lines[4]).toBe("");
  });
});

describe("/context-gc status", () => {
  test("keeps emitted available as a debug/detail metric", async () => {
    const { stats, pages } = await makeFixture();
    await stats.note("session-a", { emittedBytes: 12_800 });
    const { ctx, lines } = harness();
    await contextGcCommand(stats, pages).run(["status"], ctx);
    const output = lines.join("\n");
    expect(output).toContain("emitted 12.5 KiB");
    expect(output).toContain("for GC-modified outputs only");
  });
});

async function runSummary(stats: StatsStore, pages: PageStore) {
  const { ctx, lines } = harness();
  await contextGcCommand(stats, pages).run([], ctx);
  return { ctx, lines };
}
