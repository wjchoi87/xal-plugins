const DEFAULT_BASE_URL = "http://localhost:8000/v1";

let apiUrl = "";

export function resolveBaseUrl(config: Record<string, unknown>): string {
  const raw = config.baseUrl;
  if (raw !== undefined) {
    if (typeof raw !== "string" || !raw.trim())
      throw new Error("commandcode-bridge baseUrl must be a non-empty string");
    apiUrl = raw.trim();
  } else {
    apiUrl = DEFAULT_BASE_URL;
  }
  return apiUrl;
}

export function baseUrl(): string {
  return apiUrl;
}
