import { afterEach, describe, expect, test } from "bun:test";
import { providerFetch } from "../../api";
import { DEFAULT_CLIENT_USER_AGENT, DEFAULT_ZEN_BASE_URL } from "../../config";
import { CANONICAL_SESSION_ID, toOpenCodeSessionId } from "../../fingerprint";
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

function modelsUrl(): string {
  return `${DEFAULT_ZEN_BASE_URL}/models`;
}

describe("OpenCode session header", () => {
  test("translates the Xal session id to a canonical id on Zen inference requests", async () => {
    const captured = captureHeaders();

    await runWithOpenCodeSession("session-123", () =>
      providerFetch(
        "OpenCode Zen",
        undefined,
        `${DEFAULT_ZEN_BASE_URL}/chat/completions`,
        { method: "POST" },
      ),
    );

    const sessionId = captured.headers()?.get("x-opencode-session");
    expect(sessionId).toBe(toOpenCodeSessionId("session-123"));
    expect(sessionId).toMatch(CANONICAL_SESSION_ID);
  });

  test("passes an already-canonical session id through unchanged", async () => {
    const captured = captureHeaders();
    const canonical = "ses_0123456789abcdefGHIJKLMN01";

    await runWithOpenCodeSession(canonical, () =>
      providerFetch(
        "OpenCode Zen",
        undefined,
        `${DEFAULT_ZEN_BASE_URL}/chat/completions`,
        { method: "POST" },
      ),
    );

    expect(captured.headers()?.get("x-opencode-session")).toBe(canonical);
  });

  test("does not invent a session id outside a streaming request", async () => {
    const captured = captureHeaders();

    await providerFetch("OpenCode Zen", undefined, modelsUrl(), {
      method: "GET",
    });

    expect(captured.headers()?.get("x-opencode-session")).toBeNull();
  });
});

describe("OpenCode gateway user-agent", () => {
  test("rewrites the user-agent to the official client on gateway requests", async () => {
    const captured = captureHeaders();

    await providerFetch(
      "OpenCode Zen",
      undefined,
      `${DEFAULT_ZEN_BASE_URL}/chat/completions`,
      {
        method: "POST",
        headers: { "user-agent": "xal-opencode-free/0.1.0" },
      },
    );

    expect(captured.headers()?.get("user-agent")).toBe(
      DEFAULT_CLIENT_USER_AGENT,
    );
  });

  test("applies the gateway user-agent even when the caller sends none", async () => {
    const captured = captureHeaders();

    await providerFetch("OpenCode Zen", undefined, modelsUrl(), {
      method: "GET",
    });

    expect(captured.headers()?.get("user-agent")).toBe(
      DEFAULT_CLIENT_USER_AGENT,
    );
  });

  test("leaves non-gateway requests untouched", async () => {
    const captured = captureHeaders();

    await providerFetch(
      "models.dev",
      undefined,
      "https://models.dev/api.json",
      {
        method: "GET",
        headers: { "user-agent": "xal-opencode-free/0.1.0" },
      },
    );

    expect(captured.headers()?.get("user-agent")).toBe(
      "xal-opencode-free/0.1.0",
    );
  });
});

describe("toOpenCodeSessionId", () => {
  test("is deterministic for the same input", () => {
    expect(toOpenCodeSessionId("session-a")).toBe(
      toOpenCodeSessionId("session-a"),
    );
    expect(toOpenCodeSessionId("session-a")).not.toBe(
      toOpenCodeSessionId("session-b"),
    );
  });

  test("always produces the canonical shape", () => {
    for (const id of ["", "session-123", "ses_deadbeef", "claude:some-uuid"]) {
      expect(toOpenCodeSessionId(id)).toMatch(CANONICAL_SESSION_ID);
    }
  });
});
