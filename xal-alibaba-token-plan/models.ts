import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describeError, providerFetch, raiseForStatus } from "./api";
import { apiKey } from "./auth";
import { baseUrl } from "./config";
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
    return { models: cached.models, fromCache: true };
  }
  const live = await liveDiscover(profileId);
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
