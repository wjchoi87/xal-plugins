import { describe, expect, test } from "bun:test";
import {
  bundledContextWindowFor,
  catchAllContextWindow,
  configOverrideFor,
  configureContext,
  contextWindowsFor,
  fallbackContextWindow,
} from "../../context";

describe("bundled context table", () => {
  test("known free favorites carry a context window", () => {
    expect(bundledContextWindowFor("mimo-v2.5-free")).toBe(1_000_000);
    expect(bundledContextWindowFor("deepseek-v4-flash-free")).toBe(128 * 1024);
    expect(bundledContextWindowFor("big-pickle")).toBe(128 * 1024);
  });

  test("unknown ids fall through to undefined (catch-all is separate)", () => {
    expect(bundledContextWindowFor("some-unknown-free")).toBeUndefined();
  });

  test("catch-all always yields a conservative budget", () => {
    expect(catchAllContextWindow()).toBe(128 * 1024);
  });
});

describe("context overrides", () => {
  test("configureContext resets the override map on each call", () => {
    configureContext({ modelContextWindows: { "mimo-v2.5-free": 200_000 } });
    expect(configOverrideFor("mimo-v2.5-free")).toBe(200_000);
    // unknown override keys are not applied
    expect(configOverrideFor("deepseek-v4-flash-free")).toBeUndefined();
  });

  test("defaultContextWindow sets the config fallback", () => {
    configureContext({ defaultContextWindow: 64_000 });
    expect(fallbackContextWindow()).toBe(64_000);
  });

  test("no config leaves overrides empty and fallback undefined", () => {
    configureContext({});
    expect(configOverrideFor("mimo-v2.5-free")).toBeUndefined();
    expect(fallbackContextWindow()).toBeUndefined();
  });

  test("invalid override value throws", () => {
    expect(() => configureContext({ modelContextWindows: { a: 0 } })).toThrow();
    expect(() =>
      configureContext({ modelContextWindows: { a: -1 } }),
    ).toThrow();
    expect(() =>
      configureContext({ defaultContextWindow: "not-a-number" }),
    ).toThrow();
  });
});

describe("context window ladder", () => {
  test("no ladder when maximum does not exceed the budget", () => {
    expect(contextWindowsFor(128 * 1024)).toBeUndefined();
  });

  test("ladder starts at the budget and ends at the maximum", () => {
    const ladder = contextWindowsFor(1_000_000)!;
    expect(ladder[0]).toBe(256_000);
    expect(ladder[ladder.length - 1]).toBe(1_000_000);
    expect(ladder).toContain(400_000);
    expect(ladder).toContain(600_000);
    expect(ladder).toContain(800_000);
  });
});
