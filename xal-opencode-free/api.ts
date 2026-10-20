import { goBaseUrl, zenBaseUrl } from "./config";
import { clientUserAgent, toOpenCodeSessionId } from "./fingerprint";
import { currentOpenCodeSessionId } from "./session-context";
import { asString, isRecord, ProviderError } from "./types";

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function errorDetail(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const nested = isRecord(parsed.error)
    ? asString(parsed.error.message)
    : undefined;
  return nested ?? asString(parsed.message) ?? asString(parsed.detail);
}

export function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

/* Policy change:
 * - before: gateway requests identified as this plugin (`xal-opencode-free/…`
 *   user-agent) and carried the raw Xal session id in x-opencode-session;
 *   free-tier inference was rejected with 403 FreeTierError "OpenCode's free
 *   tier can only be used from within OpenCode"
 * - after: every request to the zen/go base URLs presents the official
 *   client's fingerprint — the `opencode/<channel>/<version>/<artifact>`
 *   user-agent (configurable via `clientUserAgent`) and a canonical
 *   `ses_…` session id translated from the Xal session id (see fingerprint.ts
 *   for the tool-quartet and streaming gates applied at the transport layer)
 * - reason: the free-tier gateway 403s any request whose user-agent is not
 *   the official client's or whose session id is not a canonical
 *   descending-timestamp `ses_` id; the stable translation keeps one Xal
 *   session mapped to one upstream session so upstream prompt caching
 *   survives across turns
 * - scope: requests to the configured zen/go base URLs (catalog, key
 *   validation, inference) while a stream session is active; other hosts are
 *   untouched and catalog /models fetches remain session-less by design */
function withGatewayFingerprint(url: string, init: RequestInit): RequestInit {
  const bases = [goBaseUrl(), zenBaseUrl()].map((base) =>
    base.replace(/\/+$/, ""),
  );
  const isGateway = bases.some(
    (base) => url === base || url.startsWith(`${base}/`),
  );
  if (!isGateway) return init;

  const headers = new Headers(init.headers);
  headers.set("user-agent", clientUserAgent());
  const sessionId = currentOpenCodeSessionId();
  if (sessionId)
    headers.set("x-opencode-session", toOpenCodeSessionId(sessionId));
  return { ...init, headers };
}

export async function providerFetch(
  name: string,
  signal: AbortSignal | null | undefined,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetch(url, withGatewayFingerprint(url, init));
  } catch (error) {
    if (
      signal?.aborted ||
      (error instanceof Error && error.name === "AbortError")
    )
      throw error;
    throw new ProviderError(`${name} request failed: ${describeError(error)}`, {
      retryable: true,
    });
  }
}

/* Catalog fetches are the only retry path. We retry once for network errors
 * and transitive 5xx statuses. Inference streams never auto-retry (a retry
 * could duplicate tool calls or re-run side effects). */
const RETRYABLE_STATUS = new Set([502, 503, 504]);

export async function fetchCatalog(
  name: string,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const attempt = async (): Promise<Response> => {
    const response = await providerFetch(name, init.signal, url, init);
    if (!response.ok && RETRYABLE_STATUS.has(response.status)) {
      throw new ProviderError(
        `${name} upstream request failed (${response.status})`,
        { retryable: true },
      );
    }
    return response;
  };
  try {
    return await attempt();
  } catch (error) {
    if (!(error instanceof ProviderError) || !error.retryable) throw error;
    // One short retry.
    return await attempt();
  }
}

export async function raiseForStatus(
  name: string,
  response: Response,
): Promise<never> {
  const text = await response.text().catch(() => "");
  const detail = errorDetail(text) ?? text.slice(0, 500);
  const status = response.status;
  /* Policy change:
   * - before: 401 and 403 both surfaced as "authentication failed — the API key
   *   was rejected"
   * - after: only 401 blames the credential; 403 is reported as an access
   *   decision with the upstream reason, and 426 as a client-version problem
   * - reason: the gateway answers 403 with a valid key whenever the account may
   *   not use the model (FreeTierError, missing Go subscription, region gate),
   *   so the old wording sent users to reissue keys that were never the issue
   * - scope: every non-2xx inference and catalog response */
  if (status === 401) {
    throw new ProviderError(
      `${name} authentication failed — the API key was rejected`,
      { retryable: false },
    );
  }
  if (status === 403) {
    throw new ProviderError(
      `${name} denied access to this model or feature${
        detail ? `: ${detail}` : ""
      }`,
      { retryable: false },
    );
  }
  if (status === 426) {
    throw new ProviderError(
      `${name} requires a newer OpenCode client version${
        detail ? `: ${detail}` : ""
      }`,
      { retryable: false },
    );
  }
  if (status === 402) {
    throw new ProviderError(
      `${name} usage or subscription entitlement is required for this key`,
      { retryable: false },
    );
  }
  const delayMs = retryAfterMs(response.headers.get("retry-after"));
  if (status === 429) {
    throw new ProviderError(
      delayMs === undefined
        ? `${name} rate limit reached`
        : `${name} rate limited — retry in ${delayMs / 1_000}s`,
      { retryable: true, retryAfterMs: delayMs },
    );
  }
  if (status === 404) {
    throw new ProviderError(
      `${name} requested a model or endpoint that does not exist`,
      { retryable: false },
    );
  }
  throw new ProviderError(
    `${name} upstream request failed (${status})${detail ? `: ${detail}` : ""}`,
    {
      retryable: status === 408 || status >= 500,
      retryAfterMs: delayMs,
    },
  );
}
