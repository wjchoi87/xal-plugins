import type { ConnectContext, ApiKeyCredential } from "./types";
import { baseUrl } from "./config";
import { PROVIDER_NAME } from "./provider";

export async function connect(
  ctx: ConnectContext,
): Promise<ApiKeyCredential | undefined> {
  ctx.print(
    `${PROVIDER_NAME} runs locally at ${baseUrl()}; no API key required`,
  );
  return { type: "api_key", key: "ollama-local" };
}
