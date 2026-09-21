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
  signal: AbortSignal | undefined,
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

export async function raiseForStatus(
  name: string,
  response: Response,
): Promise<never> {
  const text = await response.text().catch(() => "");
  const detail = errorDetail(text) ?? text.slice(0, 500);
  if (response.status === 401) {
    throw new ProviderError(
      `${name} authentication failed — the API key was rejected`,
      { retryable: false },
    );
  }
  if (response.status === 403) {
    throw new ProviderError(`${name} denied access to this model or feature`, {
      retryable: false,
    });
  }
  const delayMs = retryAfterMs(response.headers.get("retry-after"));
  if (response.status === 429) {
    throw new ProviderError(
      delayMs === undefined
        ? `${name} rate limit reached`
        : `${name} rate limited — retry in ${delayMs / 1_000}s`,
      { retryable: true, retryAfterMs: delayMs },
    );
  }
  throw new ProviderError(
    `${name} request failed (${response.status})${detail ? `: ${detail}` : ""}`,
    {
      retryable: response.status === 408 || response.status >= 500,
      retryAfterMs: delayMs,
    },
  );
}
