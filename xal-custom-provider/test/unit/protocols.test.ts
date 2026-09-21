import { afterAll, describe, expect, test } from "bun:test";
import {
  authHeadersFor,
  modelsUrlFor,
  normalizeBaseUrl,
  PROTOCOLS,
  resolveConfig,
  streamUrlFor,
} from "../../config";
import { configureRuntime } from "../../runtime";
import { resolveProfile } from "../../profile";
import { connect } from "../../auth";
import { listModels } from "../../models";
import { streamResponse } from "../../transport";
import type {
  ApiKeyCredential,
  ClientRuntime,
  ConnectContext,
  ConnectChoice,
  ConversationItem,
  StreamEvent,
  StreamRequest,
} from "../../types";

/* Xal persists the credential object verbatim; mimic that with an in-memory
 * store keyed by profile id. */
let credentials = new Map<string, ApiKeyCredential>();
const runtime: ClientRuntime = {
  app: { name: "xal-test", version: "0.0.0" },
  paths: { home: "/tmp/xal-test", cache: "/tmp/xal-test/cache" },
  credentials: {
    load: async (_providerId: string, profileId: string) =>
      credentials.get(profileId),
  },
  protectSecret: () => {},
};
configureRuntime(runtime);

function setCredential(credential: ApiKeyCredential): void {
  credentials = new Map([["profile", credential]]);
}

interface Captured {
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

function sse(frames: string[]): Response {
  return new Response(frames.map((frame) => `data: ${frame}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
  });
}

const servers: ReturnType<typeof Bun.serve>[] = [];
const captures = new Map<string, Captured>();

async function record(name: string, request: Request): Promise<void> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const text = await request.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep raw text */
  }
  captures.set(name, { path: new URL(request.url).pathname, headers, body });
}

function startServer(
  name: string,
  modelsPayload: unknown,
  streamFactory: (request: Request) => Response | Promise<Response>,
): number {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/models")) {
        await record(name, request);
        return json(modelsPayload);
      }
      return streamFactory(request);
    },
  });
  servers.push(server);
  return server.port ?? 0;
}

afterAll(() => {
  for (const server of servers) server.stop(true);
});

const userTurn: ConversationItem = {
  type: "user_message",
  text: "hi",
  images: [],
};

function streamRequest(model = "mock-model"): StreamRequest {
  return {
    instructions: "be brief",
    tools: [],
    cacheKey: "cache",
    model,
    input: [userTurn],
    toolChoice: "auto",
    sessionId: "session",
  };
}

async function collect(request: StreamRequest): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of streamResponse("profile", request)) {
    events.push(event);
  }
  return events;
}

describe("config helpers", () => {
  test("normalizes base urls", () => {
    expect(normalizeBaseUrl(" http://127.0.0.1:1/v1/ ")).toBe(
      "http://127.0.0.1:1/v1",
    );
    expect(() => normalizeBaseUrl("not a url")).toThrow(/valid URL/);
    expect(() => normalizeBaseUrl("ftp://127.0.0.1")).toThrow(/http\(s\)/);
  });

  test("maps protocols to endpoints and auth headers", () => {
    expect(streamUrlFor("http://h/v1", "chat-completions")).toBe(
      "http://h/v1/chat/completions",
    );
    expect(streamUrlFor("http://h/v1", "responses")).toBe(
      "http://h/v1/responses",
    );
    expect(streamUrlFor("http://h/v1", "anthropic-messages")).toBe(
      "http://h/v1/messages",
    );
    expect(modelsUrlFor("http://h/v1")).toBe("http://h/v1/models");
    expect(authHeadersFor("responses", "k")).toEqual({
      authorization: "Bearer k",
    });
    expect(authHeadersFor("anthropic-messages", "k")).toEqual({
      "x-api-key": "k",
      "anthropic-version": "2023-06-01",
    });
  });
});

describe("per-profile settings", () => {
  test("credential values override the global config", async () => {
    resolveConfig({
      baseUrl: "http://global.example/v1",
      protocol: "responses",
    });
    setCredential({
      type: "api_key",
      key: "k",
      baseUrl: "http://work.example/v1/",
      protocol: "anthropic-messages",
    });
    const profile = await resolveProfile("profile");
    expect(profile.baseUrl).toBe("http://work.example/v1");
    expect(profile.protocol).toBe("anthropic-messages");
    expect(profile.streamUrl).toBe("http://work.example/v1/messages");
    expect(profile.authHeaders["x-api-key"]).toBe("k");
  });

  test("legacy credentials fall back to the global config", async () => {
    resolveConfig({
      baseUrl: "http://global.example/v1",
      protocol: "responses",
    });
    setCredential({ type: "api_key", key: "k" });
    const profile = await resolveProfile("profile");
    expect(profile.baseUrl).toBe("http://global.example/v1");
    expect(profile.protocol).toBe("responses");
  });

  test("no URL anywhere fails with a connect hint", async () => {
    resolveConfig({});
    setCredential({ type: "api_key", key: "k", protocol: "responses" });
    await expect(resolveProfile("profile")).rejects.toThrow(/base URL/);
  });

  test("invalid protocol in the credential fails with a connect hint", async () => {
    resolveConfig({});
    setCredential({
      type: "api_key",
      key: "k",
      baseUrl: "http://work.example/v1",
      protocol: "graphql",
    });
    await expect(resolveProfile("profile")).rejects.toThrow(/protocol/);
  });

  test("missing credential tells the user to /connect", async () => {
    credentials = new Map();
    await expect(resolveProfile("profile")).rejects.toThrow(/connect/);
  });
});

describe("model discovery", () => {
  test("reads data-array catalogs and prefers display_name", async () => {
    const port = startServer(
      "catalog",
      {
        object: "list",
        data: [{ id: "mock-model", display_name: "Mock Model" }],
      },
      () => new Response("nope", { status: 404 }),
    );
    setCredential({
      type: "api_key",
      key: "k",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      protocol: "chat-completions",
    });
    const catalog = await listModels("profile", false);
    expect(catalog.warning).toBeUndefined();
    expect(catalog.models[0]).toMatchObject({
      id: "mock-model",
      name: "Mock Model",
    });
  });

  test("tolerates a bare-array catalog", async () => {
    const port = startServer(
      "bare",
      [{ id: "bare-model" }],
      () => new Response("nope", { status: 404 }),
    );
    setCredential({
      type: "api_key",
      key: "k",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      protocol: "chat-completions",
    });
    const catalog = await listModels("profile", false);
    expect(catalog.models.map((model) => model.id)).toEqual(["bare-model"]);
  });
});

describe("chat-completions protocol", () => {
  test("streams text and usage with Bearer auth", async () => {
    const port = startServer("chat", { data: [] }, (request) =>
      sse([
        JSON.stringify({ choices: [{ delta: { content: "Hel" } }] }),
        JSON.stringify({ choices: [{ delta: { content: "lo" } }] }),
        JSON.stringify({
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        }),
        "[DONE]",
      ]),
    );
    setCredential({
      type: "api_key",
      key: "test-key",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      protocol: "chat-completions",
    });
    const events = await collect(streamRequest());
    const texts = events.flatMap((event) =>
      event.type === "text_delta" ? [event.text] : [],
    );
    expect(texts.join("")).toBe("Hello");
    expect(events.at(-1)).toMatchObject({
      type: "done",
      usage: { totalInputTokens: 3, outputTokens: 2 },
    });
    const items = events.flatMap((event) =>
      event.type === "item_done" ? [event.item] : [],
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "assistant_message",
      text: "Hello",
    });
  });

  test("assembles streamed tool calls", async () => {
    const port = startServer("chat-tools", { data: [] }, async (request) => {
      await record("chat-tools", request);
      return sse([
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    function: { name: "get_weather", arguments: "" },
                  },
                ],
              },
            },
          ],
        }),
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '{"city":' } }],
              },
            },
          ],
        }),
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '"Seoul"}' } }],
              },
            },
          ],
        }),
        JSON.stringify({
          choices: [{ delta: {}, finish_reason: "tool_calls" }],
        }),
        "[DONE]",
      ]);
    });
    setCredential({
      type: "api_key",
      key: "test-key",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      protocol: "chat-completions",
    });
    const events = await collect(streamRequest());
    const calls = events.flatMap((event) =>
      event.type === "item_done" && event.item.type === "tool_call"
        ? [event.item]
        : [],
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      callId: "call_1",
      name: "get_weather",
      args: { city: "Seoul" },
    });
    const captured = captures.get("chat-tools");
    expect(captured?.path).toBe("/v1/chat/completions");
    expect(captured?.headers.authorization).toBe("Bearer test-key");
    expect(captured?.body).toMatchObject({ model: "mock-model", stream: true });
  });
});

describe("responses protocol", () => {
  test("streams text and usage to /responses", async () => {
    const port = startServer("responses", { data: [] }, async (request) => {
      await record("responses", request);
      return sse([
        JSON.stringify({ type: "response.output_text.delta", delta: "Hi" }),
        JSON.stringify({
          type: "response.completed",
          response: { usage: { input_tokens: 5, output_tokens: 1 } },
        }),
      ]);
    });
    setCredential({
      type: "api_key",
      key: "test-key",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      protocol: "responses",
    });
    const events = await collect(streamRequest());
    const texts = events.flatMap((event) =>
      event.type === "text_delta" ? [event.text] : [],
    );
    expect(texts.join("")).toBe("Hi");
    expect(events.at(-1)).toMatchObject({
      type: "done",
      usage: { totalInputTokens: 5, outputTokens: 1 },
    });
    const captured = captures.get("responses");
    expect(captured?.path).toBe("/v1/responses");
    expect(captured?.headers.authorization).toBe("Bearer test-key");
    expect(captured?.body).toMatchObject({
      model: "mock-model",
      store: false,
      stream: true,
    });
  });
});

describe("anthropic-messages protocol", () => {
  test("streams text, tool_use, and usage with x-api-key to /messages", async () => {
    const port = startServer("anthropic", { data: [] }, async (request) => {
      await record("anthropic", request);
      return sse([
        JSON.stringify({
          type: "message_start",
          message: {
            usage: {
              input_tokens: 10,
              cache_read_input_tokens: 2,
              cache_creation_input_tokens: 1,
            },
          },
        }),
        JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text" },
        }),
        JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hey" },
        }),
        JSON.stringify({ type: "content_block_stop", index: 0 }),
        JSON.stringify({
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "toolu_1",
            name: "get_weather",
          },
        }),
        JSON.stringify({
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"city":' },
        }),
        JSON.stringify({
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '"Seoul"}' },
        }),
        JSON.stringify({ type: "content_block_stop", index: 1 }),
        JSON.stringify({ type: "message_delta", usage: { output_tokens: 4 } }),
        JSON.stringify({ type: "message_stop" }),
      ]);
    });
    setCredential({
      type: "api_key",
      key: "test-key",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      protocol: "anthropic-messages",
    });
    const events = await collect(streamRequest());
    const texts = events.flatMap((event) =>
      event.type === "text_delta" ? [event.text] : [],
    );
    expect(texts.join("")).toBe("Hey");
    const items = events.flatMap((event) =>
      event.type === "item_done" ? [event.item] : [],
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      type: "assistant_message",
      text: "Hey",
    });
    expect(items[1]).toMatchObject({
      type: "tool_call",
      callId: "toolu_1",
      name: "get_weather",
      args: { city: "Seoul" },
    });
    expect(events.at(-1)).toMatchObject({
      type: "done",
      usage: {
        totalInputTokens: 13,
        cacheReadInputTokens: 2,
        cacheWriteInputTokens: 1,
        outputTokens: 4,
      },
    });
    const captured = captures.get("anthropic");
    expect(captured?.path).toBe("/v1/messages");
    expect(captured?.headers["x-api-key"]).toBe("test-key");
    expect(captured?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(captured?.body).toMatchObject({
      model: "mock-model",
      max_tokens: 32000,
      stream: true,
      system: [{ type: "text", text: "be brief" }],
    });
  });
});

/* ---------------- connect flow ---------------- */

interface FakeConnect {
  ctx: ConnectContext;
  printed: string[];
}

function fakeConnect(
  selectedIndex: number | undefined,
  answers: (string | undefined)[],
): FakeConnect {
  const printed: string[] = [];
  let remaining = [...answers];
  return {
    printed,
    ctx: {
      print: (line) => {
        printed.push(line);
      },
      select: async (choices: ConnectChoice[]) => {
        expect(choices.length).toBe(PROTOCOLS.length);
        return selectedIndex;
      },
      askSecret: async () => remaining.shift(),
    },
  };
}

describe("connect", () => {
  test("collects protocol, base URL, and key into the credential", async () => {
    resolveConfig({});
    const port = startServer(
      "connect",
      { object: "list", data: [{ id: "mock-model" }] },
      () => new Response("nope", { status: 404 }),
    );
    const fake = fakeConnect(2, [`http://127.0.0.1:${port}/v1`, "secret-key"]);
    const credential = await connect(fake.ctx);
    expect(credential).toMatchObject({
      type: "api_key",
      key: "secret-key",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      protocol: "anthropic-messages",
    });
    const captured = captures.get("connect");
    expect(captured?.headers["x-api-key"]).toBe("secret-key");
    expect(captured?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(fake.printed.join("\n")).toContain("anthropic-messages");
  });

  test("a rejected key aborts the connect", async () => {
    resolveConfig({});
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("{}", { status: 401 }),
    });
    servers.push(server);
    const fake = fakeConnect(0, [`http://127.0.0.1:${server.port}/v1`, "bad"]);
    await expect(connect(fake.ctx)).rejects.toThrow(/rejected/);
  });

  test("empty key stores a keyless placeholder profile", async () => {
    resolveConfig({});
    const port = startServer(
      "keyless",
      { data: [] },
      () => new Response("nope", { status: 404 }),
    );
    const fake = fakeConnect(0, [`http://127.0.0.1:${port}/v1`, ""]);
    const credential = await connect(fake.ctx);
    expect(credential).toMatchObject({
      key: "custom-local",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      protocol: "chat-completions",
    });
  });

  test("cancelling the protocol or URL returns nothing", async () => {
    const cancelled = fakeConnect(undefined, []);
    expect(await connect(cancelled.ctx)).toBeUndefined();
    const cancelledUrl = fakeConnect(0, [undefined]);
    expect(await connect(cancelledUrl.ctx)).toBeUndefined();
  });
});
