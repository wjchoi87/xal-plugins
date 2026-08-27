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

export async function providerFetch(
  name: string,
  signal: AbortSignal | null | undefined,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetch(url, init);
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
  if (status === 401 || status === 403) {
    throw new ProviderError(
      `${name} authentication failed — the API key was rejected`,
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
