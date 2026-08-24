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
  if (!ctx.askSecret) {
    throw new Error(
      `this interface cannot securely enter a ${PROVIDER_NAME} API key`,
    );
  }
  const entered = await ctx.askSecret(
    `${PROVIDER_NAME} API key (optional, press Enter to skip for a local server)`,
  );
  if (entered === undefined) return undefined;
  const key = entered.trim();
  if (!key) {
    ctx.print(
      `${PROVIDER_NAME} runs locally at ${baseUrl()}; no API key required`,
    );
    return { type: "api_key", key: "ollama-local" };
  }
  ctx.print(`connected to ${PROVIDER_NAME} with a custom API key`);
  return { type: "api_key", key };
}
