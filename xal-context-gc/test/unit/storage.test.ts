/*
 * Page storage unit tests (#11, #12, #28). Verifies byte-consistent
 * persistence, deterministic page identity, atomic-write failure behavior,
 * corrupted-index resilience and conservative session removal.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  PageStore,
  argsHashOf,
  buildPage,
  pageIdOf,
} from "../../storage/page-store";
import { StatsStore } from "../../storage/stats-store";
import { normalizeForDedup, sha256Hex } from "../../analyzer/normalize";
import { cleanupTemp, grepOutput, tempHome } from "./helpers";
import type { PageCategory } from "../../analyzer/decide";

afterEach(cleanupTemp);

function draft(
  sessionId: string,
  raw: string,
  category: PageCategory = "file",
) {
  const normalized = normalizeForDedup(raw, { stripAnsi: true });
  return buildPage({
    sessionId,
    callId: `c1`,
    tool: "read",
    argsHash: argsHashOf({ path: "x" }),
    createdAt: 1_700_000_000_000,
    title: "Read x",
    readOnly: true,
    classification: category,
    raw,
    rawBytes: Buffer.byteLength(raw, "utf8"),
    rawLines: raw.split("\n").length,
    rawSha256: sha256Hex(raw),
    normalizedSha256: sha256Hex(normalized),
  });
}

describe("page persistence", () => {
  test("writes exact UTF-8 content with deterministic id", async () => {
    const home = tempHome();
    const store = new PageStore(
      join(home, "context-gc", "pages"),
      10 * 1024 * 1024,
    );
    const raw = "안녕\n日本語\n🎉 emoji lines\nmore\n".trim();
    const { page } = draft("s1", raw);
    const result = await store.writePage("s1", { page, raw });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.page.storagePath).toContain(`${result.page.id}.txt`);
    expect(pageIdOf("s1", "c1", page.rawSha256)).toBe(page.id);
    expect(result.page.id).toHaveLength(16);

    const loaded = await store.getPage("s1", page.id);
    expect(loaded!.rawBytes).toBe(Buffer.byteLength(raw, "utf8"));
    const stored = await store.readRaw(loaded!);
    expect(stored).toBe(raw);

    // file permissions 0600 / dir 0700 on unix
    if (process.platform !== "win32") {
      const mode = statSync(result.page.storagePath).mode & 0o777;
      expect(mode).toBe(0o600);
      const dirMode = statSync(store.sessionDir("s1")).mode & 0o777;
      expect(dirMode).toBe(0o700);
    }
  });

  test("same content + callId yields same page id (no random ids)", async () => {
    const home = tempHome();
    const store = new PageStore(join(home, "context-gc", "pages"), 1024 * 1024);
    const raw = grepOutput(5);
    const { page: a } = draft("s1", raw);
    const { page: b } = draft("s1", raw);
    expect(a.id).toBe(b.id);
    // second write with identical id is a no-op (existed)
    const first = await store.writePage("s1", { page: a, raw });
    const second = await store.writePage("s1", { page: b, raw });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.ok && second.existed).toBe(true);
  });

  test("survives a restart: fresh store reads the same index", async () => {
    const home = tempHome();
    const store = new PageStore(join(home, "context-gc", "pages"), 1024 * 1024);
    const raw = grepOutput(100);
    const { page } = draft("s1", raw);
    await store.writePage("s1", { page, raw });

    const rebooted = new PageStore(
      join(home, "context-gc", "pages"),
      1024 * 1024,
    );
    const loaded = await rebooted.getPage("s1", page.id);
    expect(loaded).toBeDefined();
    const stored = await rebooted.readRaw(loaded!);
    expect(stored).toBe(raw);
  });

  test("corrupted index lines do not break lookup", async () => {
    const home = tempHome();
    const store = new PageStore(join(home, "context-gc", "pages"), 1024 * 1024);
    const raw = "hello world";
    const { page } = draft("s1", raw);
    await store.writePage("s1", { page, raw });
    appendFileSync(
      store.sessionDir("s1") + "/index.jsonl",
      "{not-json}\n",
      "utf8",
    );

    const rebooted = new PageStore(
      join(home, "context-gc", "pages"),
      1024 * 1024,
    );
    const loaded = await rebooted.getPage("s1", page.id);
    expect(loaded).toBeDefined();
  });
});

describe("page store failure paths", () => {
  test("cannot write when the pages root is occupied by a file", async () => {
    const home = tempHome();
    const dir = join(home, "context-gc", "pages");
    mkdirSync(join(home, "context-gc"), { recursive: true });
    writeFileSync(dir, "occupied", "utf8");
    const store = new PageStore(dir, 1024 * 1024);

    const raw = grepOutput(10);
    const { page } = draft("s1", raw);
    const result = await store.writePage("s1", { page, raw });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
  });

  test("readRaw of a missing page file returns undefined", async () => {
    const home = tempHome();
    const store = new PageStore(join(home, "context-gc", "pages"), 1024 * 1024);
    const raw = "x".repeat(100);
    const { page } = draft("s1", raw);
    const written = await store.writePage("s1", { page, raw });
    if (!written.ok) throw new Error("write should succeed");
    // delete the raw file behind the store's back
    const file = written.page.storagePath;
    await import("node:fs/promises").then(({ rm }) => rm(file));
    const loaded = await store.getPage("s1", page.id);
    expect(await store.readRaw(loaded!)).toBeUndefined();
  });
});

describe("session removal (#22)", () => {
  test("removeSession deletes only the target session", async () => {
    const store = new PageStore(
      join(tempHome(), "context-gc", "pages"),
      1024 * 1024,
    );
    const raw = "same raw content";
    await store.writePage("sa", {
      ...draft("sa", raw),
      page: draft("sa", raw).page,
    });
    await store.writePage("sb", {
      ...draft("sb", raw),
      page: draft("sb", raw).page,
    });

    expect(await store.removeSession("sa")).toBe(true);
    expect(await store.listSessions()).toEqual(["sb"]);
    const remaining = await store.sessionPages("sb");
    expect(remaining).toHaveLength(1);
  });
});

describe("stats persistence (#21)", () => {
  test("cumulative stats survive restart and are atomic", async () => {
    const home = tempHome();
    const root = join(home, "context-gc", "stats");
    const stats = new StatsStore(root);
    await stats.note("s1", {
      outputsObserved: 3,
      observedBytes: 9000,
      failOpenCount: 1,
    });
    await stats.note("s1", {
      outputsPaged: 2,
      pagesCreated: 2,
      duplicateHits: 1,
    });

    const rebooted = new StatsStore(root);
    const snapshot = await rebooted.snapshot("s1");
    expect(snapshot.outputsObserved).toBe(3);
    expect(snapshot.observedBytes).toBe(9000);
    expect(snapshot.failOpenCount).toBe(1);
    expect(snapshot.outputsPaged).toBe(2);
    expect(snapshot.pagesCreated).toBe(2);
    expect(snapshot.duplicateHits).toBe(1);
    expect(snapshot.version).toBe(1);
  });

  test("corrupted stats file restarts from zero", async () => {
    const home = tempHome();
    const root = join(home, "context-gc", "stats");
    const path = join(root, "s1.json");
    mkdirSync(root, { recursive: true });
    writeFileSync(path, "{broken", "utf8");

    const stats = new StatsStore(root);
    const snapshot = await stats.snapshot("s1");
    expect(snapshot.outputsObserved).toBe(0);
  });

  test("disabled stats store records nothing", async () => {
    const home = tempHome();
    const stats = new StatsStore(join(home, "context-gc", "stats"), false);
    await stats.note("s1", { outputsObserved: 5 });
    const snapshot = await stats.snapshot("s1");
    expect(snapshot.outputsObserved).toBe(0);
  });

  test("stats failures never propagate", async () => {
    const home = tempHome();
    // occupied stats path -> atomicWriteFile fails inside note()
    const root = join(home, "context-gc", "stats");
    mkdirSync(join(home, "context-gc"), { recursive: true });
    writeFileSync(root, "occupied", "utf8");
    const stats = new StatsStore(root);
    await expect(
      stats.note("s1", { outputsObserved: 1 }),
    ).resolves.toBeUndefined();
  });
});

describe("formatting", () => {
  test("page id is deterministic across store instances", () => {
    const raw = "content";
    const a = draft("s9", raw);
    const b = draft("s9", raw);
    expect(a.page.id).toBe(b.page.id);
    expect(a.page.id).toMatch(/^[0-9a-f]{16}$/);
  });

  test("pages are absent without any write", async () => {
    const home = tempHome();
    const store = new PageStore(join(home, "context-gc", "pages"), 1024 * 1024);
    expect(await store.listSessions()).toEqual([]);
    expect(await store.totalBytes()).toBe(0);
    expect(existsSync(join(home, "context-gc"))).toBe(false);
  });
});
