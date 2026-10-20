import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchCatalog } from "../../api";
import { listModels } from "../../models";
import {
  modelsEndpoint,
  parseProviderModelId,
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

test.skipIf(skip)("Zen catalog is reachable and parses", async () => {
  const zenRes = await fetchCatalog("OpenCode Zen", modelsEndpoint("zen"), {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${apiKey}`,
    },
  });
  if (!zenRes.ok) throw new Error(`zen catalog unreachable: ${zenRes.status}`);
  const zen = parseZenModels(await zenRes.json());
  expect(zen.length).toBeGreaterThan(0);
  expect(zen.every((model) => model.source === "zen")).toBe(true);
});

test.skipIf(skip)("listModels exposes only free zen models", async () => {
  const catalog = await listModels(profileId, true);
  expect(catalog).toBeDefined();
  for (const model of catalog.models) {
    const parsed = parseProviderModelId(model.id);
    expect(parsed).not.toBeUndefined();
    expect(parsed?.source).toBe("zen");
  }
});
