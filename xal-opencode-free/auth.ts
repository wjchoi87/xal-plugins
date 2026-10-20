import { providerFetch } from "./api";
import { modelsEndpoint, type OpenCodeSource } from "./model-sources";
import { PROVIDER_ID, PROVIDER_NAME } from "./provider";
import { clientRuntime } from "./runtime";
import type { ApiKeyCredential, ConnectContext } from "./types";

const VALIDATE_TIMEOUT_MS = 10_000;

export type ZenAccess = "available" | "unauthorized" | "unavailable";

/* Policy change:
 * - before: the key was validated against both Zen and Go, and a Go-only
 *   failure (e.g. HTTP 402 without a Go subscription) was reported alongside
 *   the connection
 * - after: the key is validated against Zen only; Go is no longer probed
 * - reason: Go models are served only while a Go plan subscription is
 *   active, so this plugin no longer exposes them and a Go probe tells the
 *   user nothing actionable
 * - scope: /connect validation and its printed notes */
async function probeZen(key: string): Promise<ZenAccess> {
  const source: OpenCodeSource = "zen";
  /* The gateway user-agent is applied centrally by providerFetch. */
  const response = await providerFetch(
    "OpenCode Zen",
    AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
    modelsEndpoint(source),
    {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${key}`,
      },
    },
  );
  if (response.ok) return "available";
  if (response.status === 401 || response.status === 403) return "unauthorized";
  return "unavailable";
}

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

export async function validateOpenCodeApiKey(key: string): Promise<ZenAccess> {
  return probeZen(key);
}

export async function connect(
  ctx: ConnectContext,
): Promise<ApiKeyCredential | undefined> {
  if (!ctx.askSecret)
    throw new Error(
      `this interface cannot securely enter a ${PROVIDER_NAME} API key`,
    );
  const entered = await ctx.askSecret(
    `${PROVIDER_NAME} API key (from opencode.ai/auth)`,
  );
  if (entered === undefined) return undefined;
  const key = entered.trim();
  if (!key) throw new Error(`${PROVIDER_NAME} API key cannot be empty`);

  // Ensure the key is redacted from any logged output.
  clientRuntime().protectSecret(key);

  const access = await validateOpenCodeApiKey(key);
  if (access === "unauthorized") {
    throw new Error(`${PROVIDER_NAME} API key was rejected by Zen`);
  }
  if (access !== "available") {
    throw new Error(
      `${PROVIDER_NAME} could not reach the Zen model catalog to validate the key`,
    );
  }

  ctx.print(`connected to ${PROVIDER_NAME}`);
  return { type: "api_key", key };
}
