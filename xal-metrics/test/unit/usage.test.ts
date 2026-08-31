import { describe, expect, test } from "bun:test";
import { applyUsage, cacheCoverage, hasCacheUse } from "../../metrics/usage";
import type { TurnMetrics } from "../../metrics/collector";

function turn(): Pick<
  TurnMetrics,
  "totalInputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens"
> & { stalls: number[] } {
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
