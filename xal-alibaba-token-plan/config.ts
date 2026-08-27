const DEFAULT_BASE_URL =
  "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";

let apiUrl = "";

/* Default baseUrl to Alibaba's token plan endpoint so an explicit config is
   not required. A configured value still takes precedence. */
export function resolveBaseUrl(config: Record<string, unknown>): string {
  const raw = config.baseUrl;
  if (raw === undefined) {
    apiUrl = DEFAULT_BASE_URL;
    return apiUrl;
  }
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("alibaba-token-plan baseUrl must be a non-empty string");
  }
  apiUrl = raw.trim();
  return apiUrl;
}

export function baseUrl(): string {
  return apiUrl;
}
