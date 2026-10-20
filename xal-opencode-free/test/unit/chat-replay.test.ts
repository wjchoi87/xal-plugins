import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openCodeFreeProvider } from "../../provider";
import { configureRuntime } from "../../runtime";
import type { ConversationItem, StreamRequest } from "../../types";

const originalFetch = globalThis.fetch;

function streamBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
        ),
      );
      controller.close();
    },
  });
}

/* Regression: thinking-mode upstreams (DeepSeek, MiMo) reject replayed
 * assistant history without `reasoning_content` — 400 "[invalid_request_error]
 * The `reasoning_content` in the thinking mode must be passed back to the
 * API" — so every outgoing assistant message must carry the field. */
describe("chat-completions history replay", () => {
  let bodies: Record<string, unknown>[];

  beforeEach(() => {
    bodies = [];
    configureRuntime({
      app: { name: "xal-test", version: "0.1.0" },
      paths: { home: "/unused", cache: "/unused" },
      credentials: {
        load: async () => ({ type: "api_key", key: "mock-api-key" }),
        save: async () => {},
        replace: async () => {},
      },
      protectSecret: () => {},
    });
    globalThis.fetch = (async (
      _input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      bodies.push(JSON.parse(init?.body as string));
      return new Response(streamBody());
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function request(input: ConversationItem[]): StreamRequest {
    return {
      instructions: "sys",
      tools: [],
      cacheKey: "s",
      model: "zen/deepseek-v4.1-flash-free",
      input,
      toolChoice: "none",
      sessionId: "s",
    };
  }

  async function stream(input: ConversationItem[]): Promise<void> {
    for await (const _event of openCodeFreeProvider.stream(
      "profile",
      request(input),
    ));
  }

  test("assistant turns with reasoning pass it back verbatim", async () => {
    await stream([
      {
        type: "user_message",
        text: "q1",
        images: [],
      },
      { type: "reasoning", summary: "thinking it through" },
      { type: "assistant_message", text: "a1" },
      { type: "user_message", text: "q2", images: [] },
    ]);

    expect(bodies).toHaveLength(1);
    const messages = bodies[0].messages as Record<string, unknown>[];
    expect(messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "q1" },
      {
        role: "assistant",
        content: "a1",
        reasoning_content: "thinking it through",
      },
      { role: "user", content: "q2" },
    ]);
  });

  test("assistant history without reasoning gets an explicit empty value", async () => {
    await stream([
      { type: "user_message", text: "q1", images: [] },
      { type: "assistant_message", text: "a1" },
      { type: "user_message", text: "q2", images: [] },
    ]);

    const messages = bodies[0].messages as Record<string, unknown>[];
    expect(messages[2]).toEqual({
      role: "assistant",
      content: "a1",
      reasoning_content: "",
    });
  });

  test("tool-call turns carry reasoning_content too", async () => {
    await stream([
      { type: "user_message", text: "q1", images: [] },
      { type: "reasoning", summary: "need a tool" },
      {
        type: "tool_call",
        callId: "call-1",
        name: "read",
        args: { path: "x" },
      },
      { type: "tool_result", callId: "call-1", output: "data" },
      { type: "assistant_message", text: "done" },
      { type: "user_message", text: "q2", images: [] },
    ]);

    const messages = bodies[0].messages as Record<string, unknown>[];
    const toolTurn = messages[2];
    expect(toolTurn.role).toBe("assistant");
    expect(toolTurn.reasoning_content).toBe("need a tool");
    expect(Array.isArray(toolTurn.tool_calls)).toBe(true);
    // the post-tool-result assistant turn has no reasoning item of its own,
    // so it is replayed with the explicit empty value
    expect(messages[4]).toEqual({
      role: "assistant",
      content: "done",
      reasoning_content: "",
    });
  });
});
