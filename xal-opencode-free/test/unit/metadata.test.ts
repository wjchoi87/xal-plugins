import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../../config";
import { evaluateFree } from "../../free-evaluator";
import {
  parseModelsDev,
  setUpstreamMetadata,
  syncUpstreamMetadata,
  upstreamMetadataFor,
} from "../../metadata";
import { listModels } from "../../models";
import { openCodeFreeProvider } from "../../provider";
import { parseZenModels } from "../../model-sources";
import { configureRuntime } from "../../runtime";

const originalFetch = globalThis.fetch;

/* Trimmed shape of models.dev `api.json`: providers keyed by id, each model
 * already merged with its base model (so `limit.context` is resolved). */
const MODELS_DEV = {
  openai: {
    npm: "@ai-sdk/openai",
    models: { "gpt-5": { limit: { context: 400_000, output: 128_000 } } },
  },
  opencode: {
    npm: "@ai-sdk/openai-compatible",
    api: "https://opencode.ai/inference/openai/v1",
    models: {
      "big-pickle": { limit: { context: 200_000, output: 32_000 } },
      "glm-5.3-flash-free": { limit: { context: 200_000, output: 32_000 } },
      "space-bunny-free": {
        name: "Space Bunny Free",
        limit: { context: 1_048_576, output: 32_000 },
      },
      "nemotron-3.5-super-vl-free": {
        name: "Nemotron 3.5 Super VL Free",
        limit: { context: 1_048_576, output: 32_000 },
      },
      "muse-spark-1.3-contributor-free": {
        name: "Muse Spark 1.3 Free",
        limit: { context: 1_048_576, output: 128_000 },
        provider: { npm: "@ai-sdk/openai" },
      },
      "deepseek-v4-flash-free": {
        status: "deprecated",
        limit: { context: 200_000, output: 128_000 },
      },
      "jev-1.13-free": {
        limit: { context: 0, output: 0 },
        provider: { api: "https://opencode.ai/inference/systemone/v1" },
      },
      "minimax-m3-free": {
        limit: { context: 200_000, output: 32_000 },
        provider: {
          npm: "@ai-sdk/anthropic",
          api: "https://opencode.ai/inference/anthropic/v1",
        },
      },
    },
  },
  "opencode-go": {
    npm: "@ai-sdk/openai-compatible",
    api: "https://opencode.ai/inference/go/openai/v1",
    models: {
      "cat-jam-free": { limit: { context: 1_048_576, output: 32_000 } },
      "step-5-preview-free": {
        status: "deprecated",
        limit: { context: 256_000, output: 32_000 },
      },
    },
  },
};

describe("parseModelsDev", () => {
  test("keeps only the OpenCode providers, keyed by source", () => {
    const parsed = parseModelsDev(MODELS_DEV);
    expect(Object.keys(parsed.zen)).toContain("big-pickle");
    expect(Object.keys(parsed.go)).toEqual([
      "cat-jam-free",
      "step-5-preview-free",
    ]);
    expect(parsed.zen["gpt-5"]).toBeUndefined();
  });

  test("reads context limits and retirement status", () => {
    const parsed = parseModelsDev(MODELS_DEV);
    expect(parsed.zen["space-bunny-free"]).toEqual({
      deprecated: false,
      name: "Space Bunny Free",
      contextWindow: 1_048_576,
      protocol: "chat-completions",
    });
    expect(parsed.zen["deepseek-v4-flash-free"]?.deprecated).toBe(true);
    expect(parsed.go["step-5-preview-free"]?.deprecated).toBe(true);
    // a zero context is treated as unknown, not as a 0-token window
    expect(parsed.zen["jev-1.13-free"]?.contextWindow).toBeUndefined();
  });

  test("maps each model to the protocol it is served on", () => {
    const parsed = parseModelsDev(MODELS_DEV);
    expect(parsed.zen["glm-5.3-flash-free"]?.protocol).toBe("chat-completions");
    expect(parsed.zen["muse-spark-1.3-contributor-free"]?.protocol).toBe(
      "responses",
    );
    expect(parsed.zen["minimax-m3-free"]?.protocol).toBe("anthropic-messages");
    expect(parsed.zen["jev-1.13-free"]?.protocol).toBe("unsupported");
  });

  test("rejects responses without any OpenCode model", () => {
    expect(() => parseModelsDev([])).toThrow();
    expect(() => parseModelsDev({ openai: MODELS_DEV.openai })).toThrow();
  });
});

describe("free evaluation with synced metadata", () => {
  // IDs outside the bundled exclusion list, so only synced metadata applies
  const [glm, retired, decider] = parseZenModels({
    data: [
      { id: "glm-5.3-flash-free" },
      { id: "retired-model-free" },
      { id: "decision-model-free" },
    ],
  });

  test("retired models are excluded even with a -free id", () => {
    const result = evaluateFree(retired!, { deprecated: true });
    expect(result.status).toBe("excluded");
    expect(result.reason).toBe("upstream-deprecated");
  });

  test("models on an unsupported protocol are excluded", () => {
    const result = evaluateFree(decider!, {
      deprecated: false,
      protocol: "unsupported",
    });
    expect(result.reason).toBe("unsupported-protocol");
  });

  test("an active model keeps the normal free evaluation", () => {
    const result = evaluateFree(glm!, {
      deprecated: false,
      protocol: "chat-completions",
    });
    expect(result.status).toBe("free");
  });
});

describe("syncUpstreamMetadata", () => {
  let cacheDir: string;
  let calls: string[];

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), "opencode-free-meta-"));
    calls = [];
    configureRuntime({
      app: { name: "xal-test", version: "0.1.0" },
      paths: { home: cacheDir, cache: cacheDir },
      credentials: {
        load: async () => ({ type: "api_key", key: "mock-api-key" }),
        save: async () => {},
        replace: async () => {},
      },
      protectSecret: () => {},
    });
    resolveConfig({});
    setUpstreamMetadata(undefined);
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    resolveConfig({});
    setUpstreamMetadata(undefined);
    await rm(cacheDir, { recursive: true, force: true });
  });

  function serveModelsDev(ok = true): void {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      calls.push(String(input));
      return ok
        ? Response.json(MODELS_DEV)
        : new Response("unavailable", { status: 503 });
    }) as typeof fetch;
  }

  test("fetches once, then serves the cached snapshot within the TTL", async () => {
    serveModelsDev();
    expect(await syncUpstreamMetadata(false)).toEqual({ origin: "runtime" });
    expect(upstreamMetadataFor("zen", "big-pickle")?.contextWindow).toBe(
      200_000,
    );
    setUpstreamMetadata(undefined);
    expect(await syncUpstreamMetadata(false)).toEqual({ origin: "cache" });
    expect(upstreamMetadataFor("go", "cat-jam-free")?.contextWindow).toBe(
      1_048_576,
    );
    expect(calls).toEqual(["https://models.dev/api.json"]);
  });

  test("refresh refetches even when the cache is fresh", async () => {
    serveModelsDev();
    await syncUpstreamMetadata(false);
    await syncUpstreamMetadata(true);
    expect(calls).toHaveLength(2);
  });

  test("a failed refresh falls back to the cached snapshot", async () => {
    serveModelsDev();
    await syncUpstreamMetadata(false);
    setUpstreamMetadata(undefined);
    serveModelsDev(false);
    const report = await syncUpstreamMetadata(true);
    expect(report.origin).toBe("cache");
    expect(report.error).toContain("503");
    expect(upstreamMetadataFor("zen", "big-pickle")).toBeDefined();
  });

  test("no cache and no network reports failure without throwing", async () => {
    serveModelsDev(false);
    const report = await syncUpstreamMetadata(false);
    expect(report.origin).toBe("failed");
    expect(upstreamMetadataFor("zen", "big-pickle")).toBeUndefined();
  });

  test("syncModelMetadata: false never touches the network", async () => {
    serveModelsDev();
    resolveConfig({ syncModelMetadata: false });
    expect(await syncUpstreamMetadata(true)).toEqual({ origin: "disabled" });
    expect(calls).toHaveLength(0);
  });

  test("listModels applies synced context limits and hides retired models", async () => {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      calls.push(url);
      if (url === "https://models.dev/api.json")
        return Response.json(MODELS_DEV);
      const ids = url.includes("/zen/go/")
        ? ["cat-jam-free", "step-5-preview-free", "glm-5.2"]
        : [
            "space-bunny-free",
            "nemotron-3.5-super-vl-free",
            "muse-spark-1.3-contributor-free",
            "deepseek-v4-flash-free",
            "jev-1.13-free",
            "gpt-5",
          ];
      return Response.json({ object: "list", data: ids.map((id) => ({ id })) });
    }) as typeof fetch;

    const catalog = await listModels("profile", true);
    const ids = catalog.models.map((model) => model.id);
    expect(ids).toEqual([
      "zen/muse-spark-1.3-contributor-free",
      "zen/nemotron-3.5-super-vl-free",
      "zen/space-bunny-free",
      "go/cat-jam-free",
    ]);
    // official names (minus "Free"); curated overrides still win; humanized
    // IDs keep their dots when models.dev has no name
    expect(catalog.models.map((model) => model.name)).toEqual([
      "Muse Spark 1.3 Contributor (Zen Free)",
      "Nemotron 3.5 Super VL (Zen Free)",
      "Space Bunny (Zen Free)",
      "Cat Jam (Go Free)",
    ]);
    const bunny = catalog.models.find((m) => m.id === "zen/space-bunny-free");
    // 1M from models.dev (no bundled entry) -> 256K budget + ladder up to 1M
    expect(bunny?.contextWindow).toBe(256_000);
    expect(bunny?.contextWindows?.at(-1)).toBe(1_048_576);
    // the OpenCode API key never goes to models.dev
    expect(calls.filter((url) => url.includes("models.dev"))).toHaveLength(1);
  });

  test("requests follow the synced protocol", async () => {
    setUpstreamMetadata({
      zen: {
        "minimax-m3-free": {
          deprecated: false,
          protocol: "anthropic-messages",
        },
        "space-bunny-free": { deprecated: false, protocol: "responses" },
      },
      go: {},
    });
    const seen: Array<{ url: string; apiKey: string | null }> = [];
    globalThis.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      seen.push({
        url: String(input),
        apiKey: new Headers(init?.headers).get("x-api-key"),
      });
      return new Response("nope", { status: 400 });
    }) as typeof fetch;

    for (const model of ["zen/minimax-m3-free", "zen/space-bunny-free"]) {
      const stream = openCodeFreeProvider.stream("profile", {
        instructions: "",
        tools: [],
        cacheKey: "s",
        model,
        input: [],
        toolChoice: "none",
        sessionId: "s",
      });
      await expect(
        (async () => {
          for await (const _ of stream);
        })(),
      ).rejects.toThrow();
    }
    expect(seen).toEqual([
      { url: "https://opencode.ai/zen/v1/messages", apiKey: "mock-api-key" },
      { url: "https://opencode.ai/zen/v1/responses", apiKey: null },
    ]);
  });
});
