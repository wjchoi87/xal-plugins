import { describeError, providerFetch, raiseForStatus } from "./api";
import { serverOrigin } from "./config";
import { PROVIDER_NAME } from "./provider";
import {
  asString,
  isRecord,
  type ModelCatalog,
  type ModelInfo,
  type ThinkingOptions,
} from "./types";

function thinkingFor(capabilities: unknown): ThinkingOptions | undefined {
  if (
    !Array.isArray(capabilities) ||
    !capabilities.some((value) => value === "thinking")
  )
    return undefined;
  return { options: ["none", "low", "medium", "high", "max"], default: "high" };
}

async function discoverModels(): Promise<ModelInfo[]> {
  const response = await providerFetch(
    PROVIDER_NAME,
    AbortSignal.timeout(15_000),
    `${serverOrigin()}/api/tags`,
    {
      headers: { accept: "application/json", "user-agent": "xal-ollama/0.1.0" },
    },
  );
  if (!response.ok) await raiseForStatus(PROVIDER_NAME, response);
  const raw: unknown = await response.json();
  if (!isRecord(raw) || !Array.isArray(raw.models))
    throw new Error(`${PROVIDER_NAME} models response was invalid`);
  const models: ModelInfo[] = [];
  for (const entry of raw.models) {
    if (!isRecord(entry))
      throw new Error(
        `${PROVIDER_NAME} models response contained an invalid model`,
      );
    const id = asString(entry.name);
    if (!id)
      throw new Error(
        `${PROVIDER_NAME} models response contained a model with no ID`,
      );
    const thinking = thinkingFor(entry.capabilities);
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
    return { models: await discoverModels(), source: "runtime" };
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
    const models = await discoverModels();
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
