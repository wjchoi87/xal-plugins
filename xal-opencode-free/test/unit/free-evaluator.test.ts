import { describe, expect, test } from "bun:test";
import {
  evaluateGoFree,
  evaluateZenFree,
  GO_FORCE_PAID,
  ZEN_FORCE_PAID,
  type OverrideInfo,
} from "../../free-evaluator";
import type { NormalizedOpenCodeModel } from "../../model-sources";

function zen(
  id: string,
  pricing?: NormalizedOpenCodeModel["pricing"],
): NormalizedOpenCodeModel {
  return {
    source: "zen",
    upstreamId: id,
    displayName: id,
    inputModalities: ["text"],
    transport: "chat-completions",
    ...(pricing === undefined ? {} : { pricing }),
    rawMetadata: {},
  };
}

function go(
  id: string,
  pricing?: NormalizedOpenCodeModel["pricing"],
): NormalizedOpenCodeModel {
  return {
    source: "go",
    upstreamId: id,
    displayName: id,
    inputModalities: ["text"],
    transport: "chat-completions",
    ...(pricing === undefined ? {} : { pricing }),
    rawMetadata: {},
  };
}

describe("evaluateZenFree", () => {
  test("explicit zero pricing -> free", () => {
    const model = zen("foo", { input: 0, output: 0 });
    expect(evaluateZenFree(model).status).toBe("free");
  });

  test("any positive price -> paid", () => {
    const model = zen("foo", { input: 0.1, output: 0 });
    const result = evaluateZenFree(model);
    expect(result.status).toBe("paid");
    expect(result.reason).toBe("explicit-paid-pricing");
  });

  test("no pricing + plain id -> unknown", () => {
    const result = evaluateZenFree(zen("foo"));
    expect(result.status).toBe("unknown");
  });

  test("no pricing + -free suffix -> free candidate", () => {
    const result = evaluateZenFree(zen("foo-free"));
    expect(result.status).toBe("free");
    expect(result.reason).toBe("explicit-free-model-id");
  });

  test("FORCE_PAID beats -free suffix", () => {
    const override: OverrideInfo = { reason: "manual deny override" };
    ZEN_FORCE_PAID.set("foo-free", override);
    try {
      const result = evaluateZenFree(zen("foo-free"));
      expect(result.status).toBe("paid");
      expect(result.reason).toBe("manual-paid-override");
    } finally {
      ZEN_FORCE_PAID.delete("foo-free");
    }
  });

  test("paid pricing beats -free suffix", () => {
    const result = evaluateZenFree(zen("foo-free", { input: 0.02 }));
    expect(result.status).toBe("paid");
  });

  test("big-pickle is manually free", () => {
    const result = evaluateZenFree(zen("big-pickle"));
    expect(result.status).toBe("free");
    expect(result.reason).toBe("manual-free-override");
  });

  test("undefined pricing is not treated as zero", () => {
    // Pricing object present but fields undefined must not look free.
    const result = evaluateZenFree(
      zen("bar", { input: undefined, output: undefined }),
    );
    expect(result.status).toBe("unknown");
  });
});

describe("evaluateGoFree", () => {
  test("general Go model is not free", () => {
    const result = evaluateGoFree(go("glm-5.2"));
    expect(result.status).not.toBe("free");
    expect(result.reason).toBe("go-subscription-model");
  });

  test("explicit Go free model is free", () => {
    const result = evaluateGoFree(go("ox-alpha-free"));
    expect(result.status).toBe("free");
  });

  test("Go -free id with paid metadata is NOT free", () => {
    const result = evaluateGoFree(go("ox-alpha-free", { input: 0.2 }));
    expect(result.status).not.toBe("free");
  });

  test("GO_FORCE_PAID always wins", () => {
    const override: OverrideInfo = { reason: "manual deny override" };
    GO_FORCE_PAID.set("free-thing-free", override);
    try {
      const result = evaluateGoFree(go("free-thing-free"));
      expect(result.status).toBe("paid");
      expect(result.reason).toBe("manual-paid-override");
    } finally {
      GO_FORCE_PAID.delete("free-thing-free");
    }
  });

  test("-free inside id is a free candidate", () => {
    const result = evaluateGoFree(go("preview-free-feature"));
    expect(result.status).toBe("free");
  });

  test("Go subscription model is never exposed (status paid)", () => {
    for (const id of ["glm-5.2", "grok-4.6", "qwen3.7-max", "minimax-m3"]) {
      expect(evaluateGoFree(go(id)).status).not.toBe("free");
    }
  });
});
