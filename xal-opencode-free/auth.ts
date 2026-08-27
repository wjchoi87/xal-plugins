import { providerFetch } from "./api";
import { modelsEndpoint, type OpenCodeSource } from "./model-sources";
import { PROVIDER_ID, PROVIDER_NAME } from "./provider";
import { clientRuntime } from "./runtime";
import type { ApiKeyCredential, ConnectContext } from "./types";

const VALIDATE_TIMEOUT_MS = 10_000;
const USER_AGENT = "xal-opencode-free/0.1.0";

export type ZenAccess = "available" | "unauthorized" | "unavailable";
export type GoAccess =
  "available" | "unauthorized" | "not-entitled" | "unavailable";

export interface SourceAccess {
  zen: ZenAccess;
  go: GoAccess;
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

async function probeSource(
  source: OpenCodeSource,
  key: string,
): Promise<ZenAccess | GoAccess> {
  const name = source === "zen" ? "OpenCode Zen" : "OpenCode Go";
  const response = await providerFetch(
    name,
    AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
    modelsEndpoint(source),
    {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${key}`,
        "user-agent": USER_AGENT,
      },
    },
  );
  if (response.ok) return "available";
  if (response.status === 401 || response.status === 403) return "unauthorized";
  if (response.status === 402)
    return source === "go" ? "not-entitled" : "unavailable";
  return "unavailable";
}

/* Validate the API key against Zen and Go independently. One source's
 * problem must never block the other, so we classify each on its own. */
export async function validateOpenCodeApiKey(
  key: string,
): Promise<SourceAccess> {
  const zen = (await probeSource("zen", key)) as ZenAccess;
  const go = (await probeSource("go", key)) as GoAccess;
  return { zen, go };
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

  const zenOk = access.zen === "available";
  const goOk = access.go === "available";
  if (!zenOk && !goOk) {
    if (access.zen === "unauthorized" && access.go === "unauthorized") {
      throw new Error(`${PROVIDER_NAME} API key was rejected by both sources`);
    }
    throw new Error(
      `${PROVIDER_NAME} could not reach either model catalog to validate the key`,
    );
  }

  const notes: string[] = [];
  if (!zenOk) notes.push(`Zen Free unavailable (${access.zen})`);
  if (!goOk) notes.push(`Go Free unavailable (${access.go})`);
  ctx.print(
    `connected to ${PROVIDER_NAME}${notes.length ? ` — ${notes.join("; ")}` : ""}`,
  );
  return { type: "api_key", key };
}
