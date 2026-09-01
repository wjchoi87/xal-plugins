import { describe, expect, test } from "bun:test";
import {
  applyContextUsage,
  applyUsage,
  cacheCoverage,
  contextCacheCoverage,
  hasCacheUse,
  hasContextUsage,
} from "../../metrics/usage";
import type { TurnMetrics } from "../../metrics/collector";

type UsageFields = Pick<
  TurnMetrics,
  | "totalInputTokens"
  | "outputTokens"
  | "cacheReadTokens"
  | "cacheWriteTokens"
  | "contextInputTokens"
  | "contextCacheReadTokens"
  | "contextCacheWriteTokens"
  | "contextOutputTokens"
>;

function turn(): UsageFields & { stalls: number[] } {
  return { stalls: [] };
}

describe("cacheCoverage (#9)", () => {
  test("cache read divided by full input footprint", () => {
    const access = turn();
    applyUsage(access, {
      totalInputTokens: 18_284,
      cacheReadInputTokens: 16_902,
    });
    expect(cacheCoverage(access)).toBeCloseTo(0.9244, 3);
  });

  test("undefined cacheRead yields no coverage", () => {
    const access = turn();
    applyUsage(access, { totalInputTokens: 18_284 });
    expect(cacheCoverage(access)).toBeUndefined();
  });

  test("undefined totalInputTokens yields no coverage even with cacheRead", () => {
    const access = turn();
    applyUsage(access, { cacheReadInputTokens: 500 });
    expect(cacheCoverage(access)).toBeUndefined();
  });

  test("coverage above 1 is rejected (provider semantics mismatch)", () => {
    const access = turn();
    applyUsage(access, { totalInputTokens: 100, cacheReadInputTokens: 150 });
    expect(cacheCoverage(access)).toBeUndefined();
  });

  test("zero cacheRead yields 0 coverage", () => {
    const access = turn();
    applyUsage(access, { totalInputTokens: 100, cacheReadInputTokens: 0 });
    expect(cacheCoverage(access)).toBe(0);
  });
});

describe("applyUsage undefined vs zero (#8, #20)", () => {
  test("zero is stored as zero", () => {
    const access = turn();
    applyUsage(access, {
      totalInputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
    });
    expect(access.totalInputTokens).toBe(0);
    expect(access.outputTokens).toBe(0);
    expect(access.cacheReadTokens).toBe(0);
    expect(access.cacheWriteTokens).toBe(0);
  });

  test("undefined fields are not written", () => {
    const access = turn();
    applyUsage(access, { totalInputTokens: 5 });
    expect(access.totalInputTokens).toBe(5);
    expect(access.outputTokens).toBeUndefined();
    expect(access.cacheReadTokens).toBeUndefined();
    expect(access.cacheWriteTokens).toBeUndefined();
  });

  test("undefined usage leaves the turn untouched", () => {
    const access = turn();
    applyUsage(access, undefined);
    expect(access.totalInputTokens).toBeUndefined();
  });
});

describe("hasCacheUse", () => {
  test("true when either cache field is provided", () => {
    expect(hasCacheUse({ cacheReadTokens: 0 })).toBe(true);
    expect(hasCacheUse({ cacheWriteTokens: 0 })).toBe(true);
    expect(hasCacheUse({})).toBe(false);
  });
});

describe("applyContextUsage (#3, #4, #24)", () => {
  test("stores context fields separately from turn usage", () => {
    const access = turn();
    applyUsage(access, {
      totalInputTokens: 243_210,
      outputTokens: 1_203,
      cacheReadInputTokens: 215_420,
      cacheWriteInputTokens: 22_310,
    });
    applyContextUsage(access, {
      totalInputTokens: 118_440,
      outputTokens: 55,
      cacheReadInputTokens: 111_302,
      cacheWriteInputTokens: 4_801,
    });

    expect(access.totalInputTokens).toBe(243_210);
    expect(access.contextInputTokens).toBe(118_440);
    expect(access.cacheReadTokens).toBe(215_420);
    expect(access.contextCacheReadTokens).toBe(111_302);
    expect(access.cacheWriteTokens).toBe(22_310);
    expect(access.contextCacheWriteTokens).toBe(4_801);
    expect(access.outputTokens).toBe(1_203);
    expect(access.contextOutputTokens).toBe(55);
  });

  test("undefined context usage leaves context fields untouched", () => {
    const access = turn();
    applyContextUsage(access, undefined);
    expect(access.contextInputTokens).toBeUndefined();
  });

  test("undefined fields are not written, zero is preserved", () => {
    const access = turn();
    applyContextUsage(access, { totalInputTokens: 0 });
    expect(access.contextInputTokens).toBe(0);
    expect(access.contextCacheReadTokens).toBeUndefined();
  });
});

describe("contextCacheCoverage (#24)", () => {
  test("context cache read divided by context input", () => {
    expect(
      contextCacheCoverage({
        contextInputTokens: 118_440,
        contextCacheReadTokens: 111_302,
      }),
    ).toBeCloseTo(0.9397, 3);
  });

  test("unavailable fields yield no coverage", () => {
    expect(contextCacheCoverage({})).toBeUndefined();
    expect(contextCacheCoverage({ contextInputTokens: 100 })).toBeUndefined();
    expect(
      contextCacheCoverage({ contextCacheReadTokens: 100 }),
    ).toBeUndefined();
  });

  test("coverage above 1 is rejected", () => {
    expect(
      contextCacheCoverage({
        contextInputTokens: 100,
        contextCacheReadTokens: 150,
      }),
    ).toBeUndefined();
  });
});

describe("hasContextUsage (#24)", () => {
  test("true when any context field is present", () => {
    expect(hasContextUsage({ contextInputTokens: 0 })).toBe(true);
    expect(hasContextUsage({ contextOutputTokens: 0 })).toBe(true);
    expect(hasContextUsage({})).toBe(false);
  });
});
