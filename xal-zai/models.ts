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
import {
  asString,
  isRecord,
  type ModelCatalog,
  type ModelInfo,
  type ThinkingOptions,
  type ModelInputModality,
} from "./types";

/* Whether a model supports thinking mode. GLM text models and the vision (V)
 * models expose a thinking switch; the lightweight free `-flash` models and
 * image/video generators do not. When unknown we leave it undefined so Xal
 * treats the model as non-thinking. */
function thinkingFor(id: string): ThinkingOptions | undefined {
  const lower = id.toLowerCase();
  if (/^(?:cogview|cogvideo|glm-ocr)/.test(lower)) return undefined;
  const isFlash = /\bflash\b/.test(lower) && !/flashx|flash-x/.test(lower);
  if (isFlash && !/glm-4\.6v/.test(lower)) return undefined;
  if (!lower.startsWith("glm-")) return undefined;
  return { options: ["none", "low", "medium", "high", "max"], default: "high" };
}

/* Vision (V) models and the multimodal flash accept image input; text models
 * and generators are text-only. */
function inputModalities(id: string): ModelInputModality[] {
  const lower = id.toLowerCase();
  if (/^(?:cogview|cogvideo)/.test(lower)) return ["text"];
  if (/\bv\b/.test(lower) || /glm-5\.3-flash/.test(lower)) {
    return ["text", "image"];
  }
  return ["text"];
}

/* Fill in the context window the endpoint never reports. Source precedence:
 * 1. `modelContextWindows` config override for the exact model ID
 * 2. the bundled context table
 * 3. the `defaultContextWindow` config fallback
 * 4. a value already provided by the endpoint (unknown models only)
 *
 * See context.ts for the full policy rationale. */
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

async function liveDiscover(profileId: string): Promise<ModelInfo[]> {
  const response = await providerFetch(
    PROVIDER_NAME,
    AbortSignal.timeout(15_000),
    `${baseUrl()}/models`,
    {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${await apiKey(profileId)}`,
        "user-agent": "xal-zai/0.1.0",
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
    models.push({
      id,
      name: id,
      inputModalities: inputModalities(id),
      ...(thinkingFor(id) ? { thinking: thinkingFor(id) } : {}),
    });
  }
  if (models.length === 0)
    throw new Error(`${PROVIDER_NAME} returned no models`);
  return models.map(withContextWindow);
}

export async function listModels(
  profileId: string,
  refresh: boolean,
): Promise<ModelCatalog> {
  try {
    return { models: await liveDiscover(profileId), source: "runtime" };
  } catch (error) {
    return {
      models: [],
      source: "runtime",
      warning: `model discovery failed: ${describeError(error)}`,
    };
  }
}

/* Prefer the flagship then the latest stable model when the catalog is
 * available; fall back to whichever model came back first. */
const DEFAULT_PREFERENCE = ["glm-5.3-flash", "glm-5.3", "glm-4.7"];

export async function defaultModel(profileId: string): Promise<string> {
  try {
    const models = await liveDiscover(profileId);
    for (const id of DEFAULT_PREFERENCE) {
      if (models.some((model) => model.id === id)) return id;
    }
    const first = models[0];
    if (first) return first.id;
  } catch (error) {
    throw new Error(
      `${PROVIDER_NAME} returned no models (${describeError(error)})`,
      { cause: error },
    );
  }
  throw new Error(`${PROVIDER_NAME} returned no models`);
}
