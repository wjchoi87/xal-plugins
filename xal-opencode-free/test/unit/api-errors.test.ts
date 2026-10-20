import { describe, expect, test } from "bun:test";
import { raiseForStatus } from "../../api";
import { ProviderError } from "../../types";

async function failure(status: number, body: unknown): Promise<ProviderError> {
  try {
    await raiseForStatus(
      "OpenCode Zen",
      new Response(JSON.stringify(body), { status }),
    );
  } catch (error) {
    if (error instanceof ProviderError) return error;
    throw error;
  }
  throw new Error("raiseForStatus returned without throwing");
}

describe("OpenCode error classification", () => {
  test("blames the key only for a 401", async () => {
    const error = await failure(401, { error: { message: "unauthorized" } });

    expect(error.message).toContain("API key was rejected");
    expect(error.retryable).toBe(false);
  });

  test("reports a 403 as an access decision with the upstream reason", async () => {
    const error = await failure(403, {
      type: "error",
      error: {
        type: "FreeTierError",
        message: "OpenCode's free tier can only be used from within OpenCode.",
      },
    });

    expect(error.message).toContain("denied access");
    expect(error.message).toContain("free tier can only be used");
    expect(error.message).not.toContain("API key was rejected");
    expect(error.retryable).toBe(false);
  });

  test("reports a 426 as a client version problem", async () => {
    const error = await failure(426, {
      error: { message: "OpenCode 1.18.0 or newer is required" },
    });

    expect(error.message).toContain("newer OpenCode client version");
    expect(error.message).toContain("1.18.0");
    expect(error.retryable).toBe(false);
  });
});
