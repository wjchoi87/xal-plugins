import { afterEach, describe, expect, test } from "bun:test";
import {
  parseOpenCodeVersion,
  resetOpenCodeClientVersion,
} from "../../client-version";
import { defaultClientUserAgent } from "../../config";

const originalEnv = process.env.XAL_OPENCODE_CLIENT_VERSION;

afterEach(() => {
  if (originalEnv === undefined) delete process.env.XAL_OPENCODE_CLIENT_VERSION;
  else process.env.XAL_OPENCODE_CLIENT_VERSION = originalEnv;
  resetOpenCodeClientVersion();
});

describe("OpenCode client version detection", () => {
  test("parses the CLI --version output", () => {
    expect(parseOpenCodeVersion("opencode v2.0.32\n")).toBe("2.0.32");
    expect(parseOpenCodeVersion("2.0.32")).toBe("2.0.32");
    expect(parseOpenCodeVersion("command not found")).toBeUndefined();
  });

  test("builds the default user-agent from the detected or overridden version", () => {
    process.env.XAL_OPENCODE_CLIENT_VERSION = "9.9.9";
    resetOpenCodeClientVersion();

    expect(defaultClientUserAgent()).toBe("opencode/stable/9.9.9/cli-node");
  });

  test("advertises a version at or above the verified minimum", () => {
    const version = defaultClientUserAgent().split("/")[2] ?? "";
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    const [major, minor] = version.split(".").map(Number);
    expect(major * 1000 + (minor ?? 0)).toBeGreaterThanOrEqual(1019);
  });
});
