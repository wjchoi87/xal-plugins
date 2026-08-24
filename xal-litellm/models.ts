import { describeError, providerFetch, raiseForStatus } from "./api";
import { authHeaders } from "./auth";
import { baseUrl } from "./config";
import { PROVIDER_NAME } from "./provider";
import {
  asString,
  isRecord,
  type ModelCatalog,
  type ModelInfo,
  type ThinkingOptions,
} from "./types";

function thinkingFor(id: string): ThinkingOptions | undefined {
  const lower = id.toLowerCase();
  return /\b(?:thinking|reasoning|r\d{2})\b/.test(lower)
    ? { options: ["none", "low", "medium", "high", "max"], default: "high" }
    : undefined;
}

async function discoverModels(profileId: string): Promise<ModelInfo[]> {
  const response = await providerFetch(
    PROVIDER_NAME,
    AbortSignal.timeout(15_000),
    `${baseUrl()}/models`,
    {
      headers: {
        accept: "application/json",
        ...(await authHeaders(profileId)),
        "user-agent": "xal-litellm/0.1.0",
      },
    },
  );
  if (!response.ok) await raiseForStatus(PROVIDER_NAME, response);
  const raw: unknown = await response.json();
  if (!isRecord(raw) || !Array.isArray(raw.data))
    throw new Error(
      `${PROVIDER_NAME} models response was invalid (expected {"data": [...]})`,
    );
  const models: ModelInfo[] = [];
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
    const thinking = thinkingFor(id);
    models.push({
      id,
      name: id,
      inputModalities: ["text", "image"],
      ...(thinking ? { thinking } : {}),
    });
  }
  if (models.length === 0)
    throw new Error(`${PROVIDER_NAME} returned no models`);
  return models;
}

export async function listModels(
  profileId: string,
  refresh: boolean,
): Promise<ModelCatalog> {
  try {
    return { models: await discoverModels(profileId), source: "runtime" };
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
    const models = await discoverModels(profileId);
    const first = models[0];
    if (first) return first.id;
  } catch (error) {
    throw new Error(
      `${PROVIDER_NAME} is not serving models (${describeError(error)}); start it and run /model refresh`,
      { cause: error },
    );
  }
  throw new Error(
    `${PROVIDER_NAME} is not serving any models; start it and run /model refresh`,
  );
}
