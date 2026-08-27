import { describe, expect, test } from "bun:test";
import {
  parseGoModels,
  parseProviderModelId,
  parseZenModels,
  resolveEndpoint,
  toProviderModelId,
} from "../../model-sources";

function catalog(ids: string[]): unknown {
  return {
    object: "list",
    data: ids.map((id) => ({ id, object: "model", owned_by: "opencode" })),
  };
}

describe("catalog parsers", () => {
  test("parseZenModels returns normalized zen models", () => {
    const models = parseZenModels(catalog(["deepseek-v4-flash-free", "gpt-5"]));
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      source: "zen",
      upstreamId: "deepseek-v4-flash-free",
      transport: "chat-completions",
    });
    expect(models[1].upstreamId).toBe("gpt-5");
  });

  test("parseGoModels returns normalized go models", () => {
    const models = parseGoModels(catalog(["glm-5.2", "ox-alpha-free"]));
    expect(models).toHaveLength(2);
    expect(models.every((model) => model.source === "go")).toBe(true);
  });

  test("invalid top-level structure fails the source", () => {
    expect(() => parseZenModels({ not: "a list" })).toThrow();
  });

  test("a malformed entry is skipped without killing the catalog", () => {
    const models = parseZenModels({
      object: "list",
      data: [{ id: "ok-model" }, { bad: true }, 42, "x"],
    });
    expect(models.map((model) => model.upstreamId)).toEqual(["ok-model"]);
  });

  test("empty catalog fails", () => {
    expect(() => parseZenModels(catalog([]))).toThrow();
  });
});

describe("model id routing", () => {
  test("provider ids are source-prefixed", () => {
    expect(toProviderModelId("zen", "deepseek-v4-flash-free")).toBe(
      "zen/deepseek-v4-flash-free",
    );
    expect(toProviderModelId("go", "ox-alpha-free")).toBe("go/ox-alpha-free");
  });

  test("same upstream id on zen+go yields distinct provider ids", () => {
    const zenId = toProviderModelId("zen", "glm-5.2");
    const goId = toProviderModelId("go", "glm-5.2");
    expect(zenId).not.toBe(goId);
  });

  test("parseProviderModelId round-trips", () => {
    const parsed = parseProviderModelId("zen/deepseek-v4-flash-free");
    expect(parsed).toEqual({
      source: "zen",
      upstreamId: "deepseek-v4-flash-free",
    });
  });

  test("prefix is stripped for upstream transport", () => {
    const { upstreamId } = parseProviderModelId("go/ox-alpha-free")!;
    expect(upstreamId).toBe("ox-alpha-free");
  });

  test("invalid ids reject", () => {
    expect(parseProviderModelId("random")).toBeUndefined();
    expect(parseProviderModelId("/x")).toBeUndefined();
    expect(parseProviderModelId("other/foo")).toBeUndefined();
    expect(parseProviderModelId("zen/")).toBeUndefined();
  });
});

describe("endpoint resolution", () => {
  test("maps source+transport to endpoints", () => {
    expect(resolveEndpoint("zen", "chat-completions")).toBe(
      "https://opencode.ai/zen/v1/chat/completions",
    );
    expect(resolveEndpoint("go", "chat-completions")).toBe(
      "https://opencode.ai/zen/go/v1/chat/completions",
    );
    expect(resolveEndpoint("go", "anthropic-messages")).toBe(
      "https://opencode.ai/zen/go/v1/messages",
    );
    expect(resolveEndpoint("zen", "responses")).toBe(
      "https://opencode.ai/zen/v1/responses",
    );
  });
});
