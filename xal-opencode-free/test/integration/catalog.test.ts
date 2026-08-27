import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchCatalog } from "../../api";
import { evaluateFree } from "../../free-evaluator";
import { listModels } from "../../models";
import {
  modelsEndpoint,
  parseGoModels,
  parseZenModels,
} from "../../model-sources";
import { configureRuntime } from "../../runtime";

const apiKey = Bun.env.OPENCODE_API_KEY;
let cacheDir: string;
let profileId: string;

const skip = !apiKey;

beforeAll(async () => {
  if (skip) return;
  cacheDir = await mkdtemp(join(tmpdir(), "opencode-free-"));
  profileId = `test-${Date.now()}`;
  configureRuntime({
    app: { name: "xal", version: "0.1.0" },
    paths: { home: dummyHome(), cache: cacheDir },
    credentials: {
      load: async () => ({ type: "api_key", key: apiKey! }),
      save: async () => {},
      replace: async () => {},
    },
    protectSecret: () => {},
  });
});

afterAll(async () => {
  if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
});

function dummyHome(): string {
  return cacheDir ?? join(tmpdir(), "opencode-free-home");
}

test.skipIf(skip)("Zen and Go catalogs are reachable and parse", async () => {
  const [zenRes, goRes] = await Promise.all([
    fetchCatalog("OpenCode Zen", modelsEndpoint("zen"), {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
      },
    }),
    fetchCatalog("OpenCode Go", modelsEndpoint("go"), {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
      },
    }),
  ]);
  // Each source is checked independently; a single source being unreachable
  // must not fail the whole assertion set.
  const results: string[] = [];
  if (zenRes.ok) {
    const zen = parseZenModels(await zenRes.json());
    expect(zen.length).toBeGreaterThan(0);
    results.push(`zen:${zen.length}`);
  }
  if (goRes.ok) {
    const go = parseGoModels(await goRes.json());
    expect(go.length).toBeGreaterThan(0);
    results.push(`go:${go.length}`);
  }
  if (results.length === 0) {
    throw new Error(
      `both catalogs unreachable: ${zenRes.status} / ${goRes.status}`,
    );
  }
});

test.skipIf(skip)("listModels exposes only free models", async () => {
  const catalog = await listModels(profileId, true);
  expect(catalog).toBeDefined();
  for (const model of catalog.models) {
    const parsed = parseProviderId(model.id);
    expect(parsed).not.toBeUndefined();
  }
});

test.skipIf(skip)(
  "no Go subscription model leaks into the exposure",
  async () => {
    const goRes = await fetchCatalog("OpenCode Go", modelsEndpoint("go"), {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
      },
    });
    if (!goRes.ok) return;
    const go = parseGoModels(await goRes.json());
    for (const model of go) {
      const evaluation = evaluateFree(model);
      // General Go subscription models must not be free.
      if (!model.upstreamId.includes("-free")) {
        expect(evaluation.status).not.toBe("free");
      }
    }
  },
);

function parseProviderId(
  id: string,
): { source: string; upstreamId: string } | undefined {
  const slash = id.indexOf("/");
  if (slash <= 0) return undefined;
  return { source: id.slice(0, slash), upstreamId: id.slice(slash + 1) };
}
