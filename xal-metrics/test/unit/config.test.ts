import { describe, expect, test } from "bun:test";
import { parseMetricsConfig } from "../../config";

describe("parseMetricsConfig (#35)", () => {
  test("defaults work with no configuration", () => {
    const config = parseMetricsConfig(undefined);
    expect(config.enabled).toBe(true);
    expect(config.persistence).toBe(true);
    expect(config.stallThresholdMs).toBe(1000);
    expect(config.contextGcIntegration).toBe(true);
  });

  test("explicit values win", () => {
    const config = parseMetricsConfig({
      enabled: false,
      persistence: false,
      stallThresholdMs: 500,
      contextGcIntegration: false,
    });
    expect(config.enabled).toBe(false);
    expect(config.persistence).toBe(false);
    expect(config.stallThresholdMs).toBe(500);
    expect(config.contextGcIntegration).toBe(false);
  });

  test("invalid values fall back to defaults", () => {
    expect(parseMetricsConfig({ stallThresholdMs: 0 }).stallThresholdMs).toBe(
      1000,
    );
    expect(parseMetricsConfig({ stallThresholdMs: -3 }).stallThresholdMs).toBe(
      1000,
    );
    expect(parseMetricsConfig({ stallThresholdMs: "x" }).stallThresholdMs).toBe(
      1000,
    );
  });
});
