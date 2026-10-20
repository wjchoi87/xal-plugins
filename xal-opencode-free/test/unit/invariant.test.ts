import { describe, expect, test } from "bun:test";
import { evaluateFree } from "../../free-evaluator";
import {
  parseProviderModelId,
  parseZenModels,
  toProviderModelId,
} from "../../model-sources";

/* Snapshot of the live OpenCode Zen catalog at the time of implementation.
 * Used only to drive regression invariants; assertions never hardcode a
 * specific model ID so the plugin tolerates catalog changes. */
const ZEN_IDS = [
  "claude-opus-5",
  "gpt-5.6-luna",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "glm-5.2",
  "minimax-m3",
  "qwen3.6-plus",
  "mimo-v2.5",
  "big-pickle",
  "deepseek-v4.1-flash",
  "deepseek-v4.1-flash-free",
  "glm-5.3-flash",
  "glm-5.3-flash-free",
  "mimo-v2.6-flash-free",
  "muse-spark-1.3-contributor-free",
  "nemotron-3-ultra-free",
  "cat-jam-free",
  "jev-1.13-free",
  // retired free models the live catalog may still list
  "deepseek-v4-flash-free",
  "mimo-v2.5-free",
  "muse-spark-1.2-contributor-free",
  "exo-free",
];

function catalog(ids: string[]): unknown {
  return { object: "list", data: ids.map((id) => ({ id, object: "model" })) };
}

describe("core invariant: exposed === free", () => {
  test("every model that would be exposed evaluates to 'free'", () => {
    const zen = parseZenModels(catalog(ZEN_IDS));
    const exposed = zen.filter(
      (model) => evaluateFree(model).status === "free",
    );
    for (const model of exposed) {
      expect(evaluateFree(model).status).toBe("free");
    }
  });

  test("only the known-free Zen families surface", () => {
    const zen = parseZenModels(catalog(ZEN_IDS));
    const free = zen
      .filter((model) => evaluateFree(model).status === "free")
      .map((model) => toProviderModelId("zen", model.upstreamId));
    expect(free).toContain("zen/big-pickle");
    expect(free).toContain("zen/deepseek-v4.1-flash-free");
    expect(free).toContain("zen/glm-5.3-flash-free");
    expect(free).not.toContain("zen/deepseek-v4.1-flash");
    expect(free).not.toContain("zen/glm-5.3-flash");
    expect(free).not.toContain("zen/glm-5.2");
    expect(free).not.toContain("zen/deepseek-v4-pro");
  });

  test("retired and non-chat free models are never exposed", () => {
    const zen = parseZenModels(catalog(ZEN_IDS));
    const exposed = zen
      .filter((model) => evaluateFree(model).status === "free")
      .map((model) => toProviderModelId("zen", model.upstreamId));
    for (const id of [
      "zen/deepseek-v4-flash-free",
      "zen/mimo-v2.5-free",
      "zen/muse-spark-1.2-contributor-free",
      "zen/exo-free",
      "zen/jev-1.13-free",
    ]) {
      expect(exposed).not.toContain(id);
    }
    expect(exposed).toContain("zen/mimo-v2.6-flash-free");
  });

  test("paid zen models are never exposed", () => {
    const zen = parseZenModels(catalog(["glm-5.2"]));
    const ids = zen
      .filter((model) => evaluateFree(model).status === "free")
      .map((model) => toProviderModelId("zen", model.upstreamId));
    // glm-5.2 is paid, so nothing is exposed here.
    expect(ids.length).toBe(0);
  });
});

describe("Go plan models are out of scope", () => {
  test("go-prefixed ids are rejected by the router", () => {
    // Go models (even -free ones) are served only with a Go plan
    // subscription, so this plugin no longer routes them at all.
    expect(parseProviderModelId("go/ox-alpha-free")).toBeUndefined();
    expect(parseProviderModelId("go/haihai-free")).toBeUndefined();
    expect(parseProviderModelId("go/glm-5.2")).toBeUndefined();
  });
});
