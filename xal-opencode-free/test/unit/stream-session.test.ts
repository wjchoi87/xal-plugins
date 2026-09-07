import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openCodeFreeProvider } from "../../provider";
import { configureRuntime } from "../../runtime";
import { currentOpenCodeSessionId } from "../../session-context";
import type { StreamEvent, StreamRequest } from "../../types";

const originalFetch = globalThis.fetch;

function request(sessionId: string, model: string): StreamRequest {
  return {
    instructions: "",
    tools: [],
    cacheKey: sessionId,
    model,
    input: [],
    toolChoice: "none",
    sessionId,
  };
}

function streamBody(malformed = false): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          malformed
            ? "data: invalid-json\n\n"
            : 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n',
        ),
      );
      controller.close();
    },
  });
}

describe("provider session stream lifecycle", () => {
  beforeEach(() => {
    configureRuntime({
      app: { name: "xal-test", version: "0.1.0" },
      paths: { home: "/unused", cache: "/unused" },
      credentials: {
        load: async (_providerId, profileId) => {
          await Bun.sleep(profileId === "session-a" ? 2 : 1);
          return { type: "api_key", key: "mock-api-key" };
        },
        save: async () => {},
        replace: async () => {},
      },
      protectSecret: () => {},
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  for (const model of ["go/ox-alpha-free", "zen/big-pickle"]) {
    test(`${model}: early break releases the response reader`, async () => {
      const body = streamBody();
      globalThis.fetch = (async (_input: Parameters<typeof fetch>[0]) =>
        new Response(body)) as typeof fetch;

      let received = false;
      for await (const event of openCodeFreeProvider.stream(
        "profile",
        request("session-a", model),
      )) {
        expect(event).toEqual({ type: "text_delta", text: "hello" });
        expect(body.locked).toBe(true);
        received = true;
        break;
      }

      expect(received).toBe(true);
      expect(body.locked).toBe(false);
      expect(currentOpenCodeSessionId()).toBeUndefined();
    });
  }

  test("consumer errors release the reader without replacing the error", async () => {
    const body = streamBody();
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0]) =>
      new Response(body)) as typeof fetch;
    const failure = new Error("consumer stopped");

    const consume = async () => {
      for await (const _event of openCodeFreeProvider.stream(
        "profile",
        request("session-a", "go/ox-alpha-free"),
      )) {
        throw failure;
      }
    };

    await expect(consume()).rejects.toBe(failure);
    expect(body.locked).toBe(false);
    expect(currentOpenCodeSessionId()).toBeUndefined();
  });

  test("malformed upstream data releases the reader and propagates the error", async () => {
    const body = streamBody(true);
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0]) =>
      new Response(body)) as typeof fetch;
    const iterator = openCodeFreeProvider
      .stream("profile", request("session-a", "go/ox-alpha-free"))
      [Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toThrow("malformed SSE data");
    expect(body.locked).toBe(false);
    expect(currentOpenCodeSessionId()).toBeUndefined();
  });

  test("concurrent Go and Zen sessions stay isolated", async () => {
    const seen: { model: string; sessionId: string | null }[] = [];
    const bodies: ReadableStream<Uint8Array>[] = [];
    globalThis.fetch = (async (
      _input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      seen.push({
        model: JSON.parse(init?.body as string).model,
        sessionId: new Headers(init?.headers).get("x-opencode-session"),
      });
      const body = streamBody();
      bodies.push(body);
      return new Response(body);
    }) as typeof fetch;

    for (let attempt = 0; attempt < 10; attempt++) {
      await Promise.all(
        [
          request("session-a", "go/ox-alpha-free"),
          request("session-b", "go/haihai-free"),
          request("session-zen", "zen/big-pickle"),
        ].map(async (input) => {
          const events: StreamEvent[] = [];
          for await (const event of openCodeFreeProvider.stream(
            input.sessionId,
            input,
          )) {
            events.push(event);
          }
          expect(events.map((event) => event.type)).toEqual([
            "text_delta",
            "item_done",
            "done",
          ]);
          expect(currentOpenCodeSessionId()).toBeUndefined();
        }),
      );
    }

    expect(seen).toHaveLength(30);
    for (const entry of seen) {
      expect(entry.sessionId).toBe(
        entry.model === "ox-alpha-free"
          ? "session-a"
          : entry.model === "haihai-free"
            ? "session-b"
            : "session-zen",
      );
    }
    expect(bodies.every((body) => !body.locked)).toBe(true);
  });
});
