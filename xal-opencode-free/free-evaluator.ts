import { upstreamMetadataFor, type UpstreamModelMetadata } from "./metadata";
import type { NormalizedOpenCodeModel } from "./model-sources";

export type FreeStatus = "free" | "paid" | "unknown" | "excluded";

export type FreeReason =
  | "explicit-zero-pricing"
  | "official-free-metadata"
  | "official-free-list"
  | "explicit-free-model-id"
  | "manual-free-override"
  | "explicit-paid-pricing"
  | "manual-paid-override"
  | "manual-exclude-override"
  | "upstream-deprecated"
  | "unsupported-protocol"
  | "go-subscription-model"
  | "insufficient-metadata";

export type FreeConfidence = "high" | "medium" | "low";

export interface FreeEvaluation {
  status: FreeStatus;
  reason: FreeReason;
  confidence: FreeConfidence;
}

/* Why an override exists stays traceable (and linkable to a source). */
export interface OverrideInfo {
  reason: string;
  sourceUrl?: string;
}

/* Overrides are minimal exceptions, kept per source. They are the ONLY hard
 * free/paid determinations; the dynamic catalog + evaluator are the source of
 * truth for everything else. Overrides are split Zen vs Go and free vs paid. */
export const ZEN_FORCE_FREE = new Map<string, OverrideInfo>([
  [
    "big-pickle",
    {
      reason:
        "Officially a free model despite lacking the -free suffix in its ID",
      sourceUrl: "https://opencode.ai/zen",
    },
  ],
]);

export const ZEN_FORCE_PAID = new Map<string, OverrideInfo>([]);

export const ZEN_OFFICIAL_FREE = new Map<string, OverrideInfo>([]);

export const GO_FORCE_FREE = new Map<string, OverrideInfo>([]);

export const GO_FORCE_PAID = new Map<string, OverrideInfo>([]);

export const GO_OFFICIAL_FREE = new Map<string, OverrideInfo>([]);

/* Models that may still appear in the live catalog but must never be exposed,
 * whatever their pricing: retired free models and models that do not speak
 * any protocol this plugin can stream. Checked before every other rule.
 * models.dev metadata (metadata.ts) detects both cases automatically; this list
 * is the offline fallback for when that sync is unavailable or disabled.
 *
 * Policy change:
 * - before: any catalog entry that looked free (zero pricing, `-free` id) was
 *   exposed, including retired free models and Jev (a System One
 *   structured-decision model that only serves `/systemone`)
 * - after: models listed here are dropped with reason `manual-exclude-override`
 * - reason: OpenCode marks these `status = "deprecated"` in models.dev
 *   (providers/opencode*, 2026-10) or serves them on a non-chat protocol, so a
 *   request from Xal either hits a retiring model or fails outright
 * - scope: exactly these upstream IDs on their source; every other model keeps
 *   the normal free evaluation */
const DEPRECATED: OverrideInfo = {
  reason: 'Retired free model (models.dev status = "deprecated")',
  sourceUrl: "https://github.com/sst/models.dev/tree/dev/providers/opencode",
};

export const ZEN_EXCLUDED = new Map<string, OverrideInfo>([
  ["deepseek-v4-flash-free", DEPRECATED],
  ["exo-free", DEPRECATED],
  ["hy3-free", DEPRECATED],
  ["laguna-s-2.1-free", DEPRECATED],
  ["ling-3.0-flash-fin-free", DEPRECATED],
  ["mimo-v2.5-free", DEPRECATED],
  ["muse-spark-1.2-contributor-free", DEPRECATED],
  [
    "jev-1.13-free",
    {
      reason: "System One decision model; only serves /systemone, not chat",
      sourceUrl: "https://opencode.ai/v2/docs/console/models/#jev",
    },
  ],
]);

export const GO_EXCLUDED = new Map<string, OverrideInfo>([
  ["step-5-preview-free", DEPRECATED],
]);

function excluded(
  reason: FreeReason = "manual-exclude-override",
): FreeEvaluation {
  return { status: "excluded", reason, confidence: "high" };
}

/* Synced upstream metadata: a retired model or one served on a protocol this
 * plugin cannot stream is never exposed, whatever its pricing. */
function upstreamExclusion(
  upstream: UpstreamModelMetadata | undefined,
): FreeEvaluation | undefined {
  if (upstream?.deprecated) return excluded("upstream-deprecated");
  if (upstream?.protocol === "unsupported")
    return excluded("unsupported-protocol");
  return undefined;
}

function isFreeId(id: string): boolean {
  return id.endsWith("-free") || id.includes("-free-");
}

function hasPaidPricing(model: NormalizedOpenCodeModel): boolean {
  const p = model.pricing;
  if (!p) return false;
  return [p.input, p.output, p.cacheRead, p.cacheWrite].some(
    (value) => typeof value === "number" && value > 0,
  );
}

/* Fail-closed: a model is only "all-zero priced" when the pricing object is
 * actually present AND every defined field is explicitly 0. Missing/undefined
 * fields are never treated as zero. */
function hasAllZeroPricing(model: NormalizedOpenCodeModel): boolean {
  const p = model.pricing;
  if (!p) return false;
  const defined = [p.input, p.output, p.cacheRead, p.cacheWrite].filter(
    (value): value is number => typeof value === "number",
  );
  return defined.length > 0 && defined.every((value) => value === 0);
}

/* Evaluate the Zen free status of a normalised model. */
export function evaluateZenFree(
  model: NormalizedOpenCodeModel,
  upstream?: UpstreamModelMetadata,
): FreeEvaluation {
  // Priority 0: retired / unsupported models are never exposed.
  if (ZEN_EXCLUDED.has(model.upstreamId)) return excluded();
  const upstreamExcluded = upstreamExclusion(upstream);
  if (upstreamExcluded) return upstreamExcluded;

  // Priority 1: explicit deny override always wins.
  if (ZEN_FORCE_PAID.has(model.upstreamId))
    return {
      status: "paid",
      reason: "manual-paid-override",
      confidence: "high",
    };

  // Priority 2: any explicit positive price makes the model paid.
  if (hasPaidPricing(model))
    return {
      status: "paid",
      reason: "explicit-paid-pricing",
      confidence: "high",
    };

  // Priority 3: explicit, complete zero pricing means free.
  if (hasAllZeroPricing(model))
    return {
      status: "free",
      reason: "explicit-zero-pricing",
      confidence: "high",
    };

  // Priority 4: official OpenCode "free" metadata or curated free list.
  if (ZEN_OFFICIAL_FREE.has(model.upstreamId))
    return {
      status: "free",
      reason: "official-free-list",
      confidence: "medium",
    };

  // Priority 5: manual free override (minimal exceptions).
  if (ZEN_FORCE_FREE.has(model.upstreamId))
    return {
      status: "free",
      reason: "manual-free-override",
      confidence: "medium",
    };

  // Priority 6: explicit free ID heuristic.
  if (isFreeId(model.upstreamId))
    return {
      status: "free",
      reason: "explicit-free-model-id",
      confidence: "medium",
    };

  // Priority 7: not enough information -> unknown -> dropped.
  return {
    status: "unknown",
    reason: "insufficient-metadata",
    confidence: "low",
  };
}

/* Evaluate the Go free status. Go is a paid subscription product, so its
 * catalog entries are treated as subscription/paid by default. A Go model is
 * only FREE with positive evidence it is offered free / as a free preview. */
export function evaluateGoFree(
  model: NormalizedOpenCodeModel,
  upstream?: UpstreamModelMetadata,
): FreeEvaluation {
  // Priority 0: retired / unsupported models are never exposed.
  if (GO_EXCLUDED.has(model.upstreamId)) return excluded();
  const upstreamExcluded = upstreamExclusion(upstream);
  if (upstreamExcluded) return upstreamExcluded;

  // Priority 1: explicit deny override always wins.
  if (GO_FORCE_PAID.has(model.upstreamId))
    return {
      status: "paid",
      reason: "manual-paid-override",
      confidence: "high",
    };

  // Priority 2: explicit paid/subscription metadata.
  if (hasPaidPricing(model))
    return {
      status: "paid",
      reason: "go-subscription-model",
      confidence: "high",
    };

  // Priority 3: official Go "free" metadata or curated free list.
  if (GO_OFFICIAL_FREE.has(model.upstreamId))
    return {
      status: "free",
      reason: "official-free-list",
      confidence: "medium",
    };

  // Priority 4: explicit free preview ID (*-free, *-free-*).
  if (isFreeId(model.upstreamId))
    return {
      status: "free",
      reason: "explicit-free-model-id",
      confidence: "medium",
    };

  // Priority 5: manual free override (minimal exceptions).
  if (GO_FORCE_FREE.has(model.upstreamId))
    return {
      status: "free",
      reason: "manual-free-override",
      confidence: "medium",
    };

  // Priority 6: everything else is a Go subscription model -> NOT free.
  return { status: "paid", reason: "go-subscription-model", confidence: "low" };
}

/* Dispatch to the source-appropriate evaluator. Free exposure requires the
 * status to be exactly "free". Upstream metadata defaults to the current
 * models.dev snapshot (none until a sync has run). */
export function evaluateFree(
  model: NormalizedOpenCodeModel,
  upstream: UpstreamModelMetadata | undefined = upstreamMetadataFor(
    model.source,
    model.upstreamId,
  ),
): FreeEvaluation {
  return model.source === "zen"
    ? evaluateZenFree(model, upstream)
    : evaluateGoFree(model, upstream);
}

export function isExposedFree(evaluation: FreeEvaluation): boolean {
  return evaluation.status === "free";
}
