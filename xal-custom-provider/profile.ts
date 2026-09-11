import {
  authHeadersFor,
  globalSettings,
  isProtocol,
  modelsUrlFor,
  normalizeBaseUrl,
  streamUrlFor,
  type Protocol,
} from "./config";
import { PROVIDER_ID, PROVIDER_NAME } from "./provider";
import { clientRuntime } from "./runtime";
import { ProviderError } from "./types";

export interface ProfileSettings {
  protocol: Protocol;
  key: string;
  baseUrl: string;
  modelsUrl: string;
  streamUrl: string;
  authHeaders: Record<string, string>;
}

/* The custom provider stores baseUrl + protocol inside the credential, so
 * each Xal connection profile carries its own endpoint. Credentials created
 * before that (install-time config) or entered as plain keys fall back to the
 * global pluginConfig values. */
export async function resolveProfile(
  profileId: string,
): Promise<ProfileSettings> {
  const credential = await clientRuntime().credentials.load(
    PROVIDER_ID,
    profileId,
  );
  if (credential?.type !== "api_key")
    throw new ProviderError(
      `not connected to ${PROVIDER_NAME} — run /connect`,
      { retryable: false },
    );
  const fallback = globalSettings();
  const rawUrl = credential.baseUrl ?? fallback.baseUrl;
  if (!rawUrl)
    throw new ProviderError(
      `${PROVIDER_NAME} profile has no base URL — re-run /connect to set one`,
      { retryable: false },
    );
  const rawProtocol = credential.protocol ?? fallback.protocol;
  if (!isProtocol(rawProtocol))
    throw new ProviderError(
      `${PROVIDER_NAME} profile has an invalid protocol — re-run /connect to pick chat-completions, responses, or anthropic-messages`,
      { retryable: false },
    );
  let baseUrl: string;
  try {
    baseUrl = normalizeBaseUrl(rawUrl);
  } catch (error) {
    throw new ProviderError(
      `${PROVIDER_NAME} profile has an invalid base URL: ${String(error)}`,
      { retryable: false },
    );
  }
  return {
    protocol: rawProtocol,
    key: credential.key,
    baseUrl,
    modelsUrl: modelsUrlFor(baseUrl),
    streamUrl: streamUrlFor(baseUrl, rawProtocol),
    authHeaders: authHeadersFor(rawProtocol, credential.key),
  };
}
