let apiUrl = "";

export function resolveBaseUrl(config: Record<string, unknown>): string {
  const raw = config.baseUrl;
  if (raw === undefined) {
    throw new Error(
      'set pluginConfig["alibaba-token-plan"].baseUrl to your OpenAI-compatible endpoint',
    );
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
