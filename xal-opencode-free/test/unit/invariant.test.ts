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

const GO_IDS = [
  "glm-5.2",
  "deepseek-v4-pro",
  "qwen3.7-max",
  "grok-4.6",
  "minimax-m3",
  "haihai-free",
  "ox-alpha-free",
  "step-5-preview-free",
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
        expect([
          "go-subscription-model",
          "manual-paid-override",
          "manual-exclude-override",
        ]).toContain(evalResult.reason);
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
    const go = parseGoModels(catalog(GO_IDS));
    const exposed = [...zen, ...go]
      .filter((model) => evaluateFree(model).status === "free")
      .map((model) => toProviderModelId(model.source, model.upstreamId));
    for (const id of [
      "zen/deepseek-v4-flash-free",
      "zen/mimo-v2.5-free",
      "zen/muse-spark-1.2-contributor-free",
      "zen/exo-free",
      "zen/jev-1.13-free",
      "go/step-5-preview-free",
    ]) {
      expect(exposed).not.toContain(id);
    }
    expect(exposed).toContain("zen/mimo-v2.6-flash-free");
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
