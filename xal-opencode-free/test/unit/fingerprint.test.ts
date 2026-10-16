import { afterEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_CLIENT_USER_AGENT,
  clientUserAgent,
  resolveConfig,
} from "../../config";
import {
  FINGERPRINT_TOOL_NAMES,
  mergedTools,
  toOpenCodeSessionId,
} from "../../fingerprint";
import type { ToolDefinition } from "../../types";

afterEach(() => {
  resolveConfig({});
});

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `caller tool ${name}`,
    parameters: { type: "object", properties: {} },
  };
}

describe("mergedTools", () => {
  test("declares the fingerprint quartet when the caller sends no tools", () => {
    const names = mergedTools([]).map((entry) => entry.name);
    expect(names).toEqual(FINGERPRINT_TOOL_NAMES);
  });

  test("keeps caller tools verbatim and appends only missing quartet members", () => {
    const caller = [tool("edit"), tool("bash")];
    const merged = mergedTools(caller);

    expect(merged.slice(0, caller.length)).toEqual(caller);
    expect(merged.map((entry) => entry.name)).toEqual([
      "edit",
      "bash",
      ...FINGERPRINT_TOOL_NAMES.filter((name) => name !== "bash"),
    ]);
  });

  test("returns the caller list unchanged when the quartet is complete", () => {
    const caller = FINGERPRINT_TOOL_NAMES.map(tool);
    expect(mergedTools(caller)).toBe(caller);
  });
});

describe("clientUserAgent config", () => {
  test("defaults to the official client user-agent", () => {
    resolveConfig({});
    expect(clientUserAgent()).toBe(DEFAULT_CLIENT_USER_AGENT);
  });

  test("can be overridden for a raised gateway minimum version", () => {
    resolveConfig({ clientUserAgent: "opencode/9.9.99" });
    expect(clientUserAgent()).toBe("opencode/9.9.99");
  });

  test("rejects an empty value", () => {
    expect(() => resolveConfig({ clientUserAgent: "  " })).toThrow(
      /clientUserAgent/,
    );
  });
});

describe("toOpenCodeSessionId", () => {
  test("maps one Xal session to exactly one canonical session id", () => {
    expect(toOpenCodeSessionId("session-a")).toBe(
      toOpenCodeSessionId("session-a"),
    );
    expect(toOpenCodeSessionId("session-a")).toMatch(
      /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/,
    );
  });

  test("encodes a descending (bitwise-NOT) timestamp in the hex part", () => {
    const id = toOpenCodeSessionId("session-a");
    const firstByte = Number.parseInt(id.slice(4, 6), 16);
    // Descending ids are the two's complement of timestamp*0x1000+counter,
    // so the leading byte carries the sign bits (>= 0x80); an ascending or
    // random hex part (e.g. from a plain hash) does not and fails the gate.
    expect(firstByte).toBeGreaterThanOrEqual(0x80);
  });
});
