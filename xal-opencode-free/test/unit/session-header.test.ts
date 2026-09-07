import { afterEach, describe, expect, test } from "bun:test";
import { providerFetch } from "../../api";
import { DEFAULT_GO_BASE_URL, DEFAULT_ZEN_BASE_URL } from "../../config";
import { runWithOpenCodeSession } from "../../session-context";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function captureHeaders(): { headers: () => Headers | undefined } {
  let seen: Headers | undefined;
  globalThis.fetch = (async (
    _input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    seen = new Headers(init?.headers);
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  return { headers: () => seen };
}

describe("OpenCode session header", () => {
  test("adds the stable Xal session id to Go inference requests", async () => {
    const captured = captureHeaders();

    await runWithOpenCodeSession("session-123", () =>
      providerFetch(
        "OpenCode Go",
        undefined,
        `${DEFAULT_GO_BASE_URL}/chat/completions`,
        { method: "POST" },
      ),
    );

    expect(captured.headers()?.get("x-opencode-session")).toBe("session-123");
  });

  test("adds the stable Xal session id to Zen inference requests", async () => {
    const captured = captureHeaders();

    await runWithOpenCodeSession("session-123", () =>
      providerFetch(
        "OpenCode Zen",
        undefined,
        `${DEFAULT_ZEN_BASE_URL}/chat/completions`,
        { method: "POST" },
      ),
    );

    expect(captured.headers()?.get("x-opencode-session")).toBe("session-123");
  });

  test("does not invent a session id outside a streaming request", async () => {
    const captured = captureHeaders();

    await providerFetch(
      "OpenCode Go",
      undefined,
      `${DEFAULT_GO_BASE_URL}/models`,
      { method: "GET" },
    );

    expect(captured.headers()?.get("x-opencode-session")).toBeNull();
  });
});
