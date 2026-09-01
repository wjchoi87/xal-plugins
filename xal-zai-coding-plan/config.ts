const DEFAULT_BASE_URL = "https://api.z.ai/api/coding/paas/v4";

let apiUrl = "";

/* z.ai's GLM Coding Plan OpenAI-compatible endpoint is the default, so an
 * explicit config is not required. A configured value (e.g. the non-coding
 * endpoint or a custom proxy) still takes precedence. */
export function resolveBaseUrl(config: Record<string, unknown>): string {
  const raw = config.baseUrl;
  if (raw === undefined) {
    apiUrl = DEFAULT_BASE_URL;
    return apiUrl;
  }
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("zai-coding-plan baseUrl must be a non-empty string");
  }
  apiUrl = raw.trim();
  return apiUrl;
}

export function baseUrl(): string {
  return apiUrl;
}
