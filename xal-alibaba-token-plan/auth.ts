import { providerFetch } from "./api";
import { baseUrl } from "./config";
import { PROVIDER_ID, PROVIDER_NAME } from "./provider";
import { clientRuntime } from "./runtime";
import type { ApiKeyCredential, ConnectContext } from "./types";

export async function apiKey(profileId: string): Promise<string> {
  const credential = await clientRuntime().credentials.load(
    PROVIDER_ID,
    profileId,
  );
  if (credential?.type !== "api_key" || !credential.key) {
    throw new Error(`not connected to ${PROVIDER_NAME} — run /connect`);
  }
  return credential.key;
}

export async function connect(
  ctx: ConnectContext,
): Promise<ApiKeyCredential | undefined> {
  if (!ctx.askSecret)
    throw new Error(
      `this interface cannot securely enter a ${PROVIDER_NAME} API key`,
    );
  const entered = await ctx.askSecret(`${PROVIDER_NAME} API key`);
  if (entered === undefined) return undefined;
  const key = entered.trim();
  if (!key) throw new Error(`${PROVIDER_NAME} API key cannot be empty`);
  const response = await providerFetch(
    PROVIDER_NAME,
    AbortSignal.timeout(15_000),
    `${baseUrl()}/models`,
    {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${key}`,
        "user-agent": "xal-alibaba-token-plan/0.1.0",
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
      ? `connected to ${PROVIDER_NAME}`
      : `model discovery unavailable (HTTP ${response.status}); connected to ${PROVIDER_NAME}`,
  );
  return { type: "api_key", key };
}
