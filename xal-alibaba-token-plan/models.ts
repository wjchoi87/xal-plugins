import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describeError, providerFetch, raiseForStatus } from "./api";
import { apiKey } from "./auth";
import { baseUrl } from "./config";
import {
  bundledContextWindowFor,
  configOverrideFor,
  contextWindowsFor,
  fallbackContextWindow,
} from "./context";
import { PROVIDER_NAME } from "./provider";
import { clientRuntime } from "./runtime";
import {
  asString,
  isRecord,
  type ModelCatalog,
  type ModelInfo,
  type ThinkingOptions,
} from "./types";

const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

interface CacheEntry {
  updatedAt: number;
  models: ModelInfo[];
}

function thinkingFor(supported: boolean): ThinkingOptions | undefined {
  if (!supported) return undefined;
  return { options: ["none", "low", "medium", "high", "max"], default: "high" };
}

/* Fill in the context window the endpoint never reports. Source precedence:
 * 1. `modelContextWindows` config override for the exact model ID
 * 2. the bundled context table
 * 3. the `defaultContextWindow` config fallback
 * 4. a value already provided by the endpoint/cache (unknown models only)
 *
 * The bundled/override value is the model's maximum. Xal's session budget uses
 * a conservative default (min of the maximum and 256K) so compaction engages
 * early, and a `contextWindows` ladder lets `/context-window` raise the budget
 * up to the maximum — the ladder shape Xal's own OpenAI provider uses. Xal
 * validates that the ladder's first rung equals `contextWindow`, so the value
 * exposed as `contextWindow` is the budget, never the raw maximum.
 *
 * Policy change:
 * - before: ModelInfo.contextWindow stayed undefined, so Xal had no context
 *   budget, could not compact, and `/context-window` was unsupported
 * - after: known models carry a context window (budget) plus a selectable
 *   ladder when their maximum exceeds the default budget; unknown IDs stay
 *   untouched unless `defaultContextWindow` is configured
 * - reason: the OpenAI-compatible `/models` response has no context field
 * - scope: catalog entries returned to Xal, both live and cached */
function withContextWindow(model: ModelInfo): ModelInfo {
  const maximum =
    configOverrideFor(model.id) ??
    bundledContextWindowFor(model.id) ??
    fallbackContextWindow() ??
    model.contextWindow;
  if (maximum === undefined) return model;
  const contextWindows = contextWindowsFor(maximum);
  const budget = contextWindows?.[0] ?? maximum;
  if (model.contextWindow === budget && contextWindows === undefined)
    return model;
  return {
    ...model,
    contextWindow: budget,
    ...(contextWindows === undefined ? {} : { contextWindows }),
  };
}

async function cachePath(profileId: string): Promise<string> {
  return join(
    clientRuntime().paths.cache,
    `xal-alibaba-token-plan-models-${profileId}.json`,
  );
}

async function readCache(profileId: string): Promise<CacheEntry | undefined> {
  try {
    const raw: unknown = JSON.parse(
      await readFile(await cachePath(profileId), "utf8"),
    );
    if (
      !isRecord(raw) ||
      typeof raw.updatedAt !== "number" ||
      !Array.isArray(raw.models)
    )
      return undefined;
    return { updatedAt: raw.updatedAt, models: raw.models as ModelInfo[] };
  } catch {
    return undefined;
  }
}

async function writeCache(
  profileId: string,
  models: ModelInfo[],
): Promise<void> {
  const path = await cachePath(profileId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({ updatedAt: Date.now(), models }),
    "utf8",
  );
}

async function probeReasoning(
  profileId: string,
  modelId: string,
): Promise<boolean> {
  const response = await providerFetch(
    PROVIDER_NAME,
    AbortSignal.timeout(30_000),
    `${baseUrl()}/chat/completions`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await apiKey(profileId)}`,
        "user-agent": "xal-alibaba-token-plan/0.1.0",
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 8,
        stream: false,
        reasoning_effort: "high",
      }),
    },
  );
  if (!response.ok) return false;
  const raw: unknown = await response.json().catch(() => undefined);
  if (!isRecord(raw) || !Array.isArray(raw.choices)) return false;
  const choice = raw.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) return false;
  const message = choice.message;
  return (
    asString(message.reasoning_content) !== undefined ||
    asString(message.reasoning) !== undefined
  );
}

async function liveDiscover(profileId: string): Promise<ModelInfo[]> {
  const response = await providerFetch(
    PROVIDER_NAME,
    AbortSignal.timeout(15_000),
    `${baseUrl()}/models`,
    {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${await apiKey(profileId)}`,
        "user-agent": "xal-alibaba-token-plan/0.1.0",
      },
    },
  );
  if (!response.ok) await raiseForStatus(PROVIDER_NAME, response);
  const raw: unknown = await response.json();
  if (!isRecord(raw) || !Array.isArray(raw.data))
    throw new Error(`${PROVIDER_NAME} models response was invalid`);
  const ids: string[] = [];
  for (const entry of raw.data) {
    if (!isRecord(entry))
      throw new Error(
        `${PROVIDER_NAME} models response contained an invalid model`,
      );
    const id = asString(entry.id);
    if (!id)
      throw new Error(
        `${PROVIDER_NAME} models response contained a model with no ID`,
      );
    ids.push(id);
  }
  if (ids.length === 0) throw new Error(`${PROVIDER_NAME} returned no models`);
  const probed = await Promise.all(
    ids.map(async (id) => ({
      id,
      supported: await probeReasoning(profileId, id),
    })),
  );
  return probed.map(({ id, supported }) => ({
    id,
    name: id,
    inputModalities: ["text", "image"],
    ...(thinkingFor(supported) ? { thinking: thinkingFor(supported) } : {}),
  }));
}

async function models(profileId: string): Promise<{
  models: ModelInfo[];
  fromCache: boolean;
}> {
  const cached = await readCache(profileId);
  if (cached && Date.now() - cached.updatedAt < CACHE_TTL_MS) {
    /* Enrich on read so catalogs cached before context windows existed (and
     * therefore stored without them) still get a context window. */
    return { models: cached.models.map(withContextWindow), fromCache: true };
  }
  const live = (await liveDiscover(profileId)).map(withContextWindow);
  await writeCache(profileId, live);
  return { models: live, fromCache: false };
}

export async function listModels(
  profileId: string,
  refresh: boolean,
): Promise<ModelCatalog> {
  try {
    const { models: result, fromCache } = await models(profileId);
    return {
      models: result,
      source: refresh || !fromCache ? "runtime" : "cache",
    };
  } catch (error) {
    return {
      models: [],
      source: "runtime",
      warning: `model discovery failed: ${describeError(error)}`,
    };
  }
}

export async function defaultModel(profileId: string): Promise<string> {
  try {
    const { models: result } = await models(profileId);
    const first = result[0];
    if (first) return first.id;
  } catch (error) {
    throw new Error(
      `${PROVIDER_NAME} returned no models (${describeError(error)})`,
      { cause: error },
    );
  }
  throw new Error(`${PROVIDER_NAME} returned no models`);
}
