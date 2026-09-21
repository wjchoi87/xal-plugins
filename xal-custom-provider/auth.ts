import { providerFetch } from "./api";
import {
  authHeadersFor,
  globalSettings,
  modelsUrlFor,
  normalizeBaseUrl,
  PROTOCOLS,
  type Protocol,
} from "./config";
import { PROVIDER_NAME } from "./provider";
import type { ApiKeyCredential, ConnectChoice, ConnectContext } from "./types";

const USER_AGENT = "xal-custom-provider/0.1.0";
const KEYLESS_PLACEHOLDER = "custom-local";

export const PROTOCOL_CHOICES: ConnectChoice[] = [
  {
    label: "OpenAI Chat Completions",
    detail: "POST {base}/chat/completions — vLLM, LiteLLM, Ollama, OpenRouter",
  },
  {
    label: "OpenAI Responses",
    detail: "POST {base}/responses — OpenAI Responses API servers",
  },
  {
    label: "Anthropic Messages",
    detail: "POST {base}/messages — Anthropic API and compatible gateways",
  },
];

function baseUrlPrompt(globalUrl: string | undefined): string {
  const hint = globalUrl ? `, Enter = keep global ${globalUrl}` : "";
  return `${PROVIDER_NAME} base URL (version root, e.g. http://localhost:8000/v1 or https://api.anthropic.com/v1${hint})`;
}

export async function connect(
  ctx: ConnectContext,
): Promise<ApiKeyCredential | undefined> {
  if (!ctx.askSecret) {
    throw new Error(
      `this interface cannot securely enter a ${PROVIDER_NAME} API key`,
    );
  }
  const choice = await ctx.select(PROTOCOL_CHOICES);
  if (choice === undefined) return undefined;
  const protocol: Protocol | undefined = PROTOCOLS[choice];
  if (!protocol)
    throw new Error(`${PROVIDER_NAME} got an unknown protocol choice`);
  const fallback = globalSettings();

  const urlAnswer = await ctx.askSecret(baseUrlPrompt(fallback.baseUrl));
  if (urlAnswer === undefined) return undefined;
  const rawUrl = urlAnswer.trim();
  const baseUrl = normalizeBaseUrl(rawUrl || (fallback.baseUrl ?? ""));

  const entered = await ctx.askSecret(
    `${PROVIDER_NAME} API key for ${baseUrl} (optional, press Enter to skip for an unauthenticated server)`,
  );
  if (entered === undefined) return undefined;
  const key = entered.trim();
  if (!key) {
    ctx.print(
      `${PROVIDER_NAME} (${protocol}) will be reached without an API key at ${baseUrl}`,
    );
    return { type: "api_key", key: KEYLESS_PLACEHOLDER, baseUrl, protocol };
  }
  const response = await providerFetch(
    PROVIDER_NAME,
    AbortSignal.timeout(15_000),
    modelsUrlFor(baseUrl),
    {
      headers: {
        accept: "application/json",
        ...authHeadersFor(protocol, key),
        "user-agent": USER_AGENT,
      },
    },
  );
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `${PROVIDER_NAME} API key was rejected (HTTP ${response.status})`,
    );
  }
  ctx.print(
    response.ok
      ? `connected to ${PROVIDER_NAME} via ${protocol}`
      : `connected to ${PROVIDER_NAME} via ${protocol} but model discovery failed (HTTP ${response.status})`,
  );
  return { type: "api_key", key, baseUrl, protocol };
}
