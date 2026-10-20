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

/* Z.ai answers 429 both for genuine rate limiting and for an account with no
 * remaining resource package (error code 1113 / "Insufficient balance or no
 * resource package"). Only the former can succeed on retry, so the latter is
 * reported as a non-retryable entitlement problem with the upstream wording. */
const ENTITLEMENT_CODES = new Set(["1113"]);
const ENTITLEMENT_PATTERN = /insufficient balance|no resource package/i;

function entitlementReason(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : {};
  const rawCode = error.code;
  const code =
    typeof rawCode === "number" || typeof rawCode === "string"
      ? String(rawCode)
      : undefined;
  const message = asString(error.message);
  if (code !== undefined && ENTITLEMENT_CODES.has(code))
    return message ?? `error ${code}`;
  if (message !== undefined && ENTITLEMENT_PATTERN.test(message))
    return message;
  return undefined;
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
  /* Policy change:
   * - before: every 429 became a retryable rate-limit error, so an account
   *   without an active resource package was retried until the attempt budget
   *   ran out ("retrying in 1s · attempt 2/6 · rate limit reached").
   * - after: a 429 carrying entitlement evidence (code 1113 or the balance /
   *   resource-package message) fails fast as non-retryable and keeps the
   *   upstream explanation; only real throttling stays retryable.
   * - reason: retrying a balance problem can never succeed and hides the
   *   actual cause from the user.
   * - scope: 429 responses from the chat/completions and catalog endpoints. */
  if (response.status === 429) {
    const entitlement = entitlementReason(text);
    if (entitlement !== undefined) {
      throw new ProviderError(
        `${name} usage or subscription entitlement is required for this key: ${entitlement}`,
        { retryable: false },
      );
    }
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
