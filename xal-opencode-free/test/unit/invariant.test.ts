import { describe, expect, test } from "bun:test";
import { evaluateFree } from "../../free-evaluator";
import {
  parseGoModels,
  parseZenModels,
  toProviderModelId,
} from "../../model-sources";

/* Snapshot of the live OpenCode catalogs at the time of implementation.
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
  "deepseek-v4-flash-free",
  "muse-spark-1.2-contributor-free",
  "mimo-v2.5-free",
  "hy3-free",
  "nemotron-3-ultra-free",
  "laguna-s-2.1-free",
];

const GO_IDS = [
  "glm-5.2",
  "deepseek-v4-pro",
  "qwen3.7-max",
  "grok-4.6",
  "minimax-m3",
  "haihai-free",
  "ox-alpha-free",
];

function catalog(ids: string[]): unknown {
  return { object: "list", data: ids.map((id) => ({ id, object: "model" })) };
}

describe("core invariant: exposed === free", () => {
  test("every model that would be exposed evaluates to 'free'", () => {
    const zen = parseZenModels(catalog(ZEN_IDS));
    const go = parseGoModels(catalog(GO_IDS));
    const all = [...zen, ...go];
    const exposed = all.filter(
      (model) => evaluateFree(model).status === "free",
    );
    for (const model of exposed) {
      expect(evaluateFree(model).status).toBe("free");
    }
  });

  test("no Go subscription model is ever exposed", () => {
    const go = parseGoModels(catalog(GO_IDS));
    for (const model of go) {
      const evalResult = evaluateFree(model);
      if (evalResult.status !== "free") {
        expect(["go-subscription-model", "manual-paid-override"]).toContain(
          evalResult.reason,
        );
      }
    }
    const exposedGo = go.filter(
      (model) => evaluateFree(model).status === "free",
    );
    expect(exposedGo.every((model) => model.upstreamId.includes("free"))).toBe(
      true,
    );
  });

  test("only the known-free Zen families surface", () => {
    const zen = parseZenModels(catalog(ZEN_IDS));
    const free = zen
      .filter((model) => evaluateFree(model).status === "free")
      .map((model) => toProviderModelId("zen", model.upstreamId));
    expect(free).toContain("zen/deepseek-v4-flash-free");
    expect(free).toContain("zen/big-pickle");
    expect(free).not.toContain("zen/glm-5.2");
    expect(free).not.toContain("zen/deepseek-v4-pro");
  });

  test("dedupe + source prefix keeps zen and go same-name distinct", () => {
    const zen = parseZenModels(catalog(["glm-5.2"]));
    const go = parseGoModels(catalog(["glm-5.2"]));
    const ids = new Set(
      [...zen, ...go]
        .filter((model) => evaluateFree(model).status === "free")
        .map((model) => toProviderModelId(model.source, model.upstreamId)),
    );
    // glm-5.2 is paid on both, so nothing is exposed here.
    expect(ids.size).toBe(0);
  });
});
