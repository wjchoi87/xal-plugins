export const PROTOCOLS = [
  "chat-completions",
  "responses",
  "anthropic-messages",
] as const;

export type Protocol = (typeof PROTOCOLS)[number];

export const ANTHROPIC_VERSION = "2023-06-01";

export function isProtocol(value: unknown): value is Protocol {
  return (
    typeof value === "string" &&
    (PROTOCOLS as readonly string[]).includes(value)
  );
}

export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("custom provider base URL must not be empty");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`custom provider base URL is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error(
      `custom provider base URL must be http(s), got ${url.protocol}`,
    );
  return trimmed;
}

export function modelsUrlFor(baseUrl: string): string {
  return `${baseUrl}/models`;
}

export function streamUrlFor(baseUrl: string, protocol: Protocol): string {
  switch (protocol) {
    case "responses":
      return `${baseUrl}/responses`;
    case "anthropic-messages":
      return `${baseUrl}/messages`;
    case "chat-completions":
      return `${baseUrl}/chat/completions`;
  }
}

export function authHeadersFor(
  protocol: Protocol,
  key: string,
): Record<string, string> {
  if (protocol === "anthropic-messages")
    return {
      "x-api-key": key,
      "anthropic-version": ANTHROPIC_VERSION,
    };
  return { authorization: `Bearer ${key}` };
}

/* Optional install-time defaults kept for pre-profile installs and for
 * connecting a profile without re-entering a URL. Per-profile values stored
 * in the credential (see profile.ts) take precedence. */
let globalBaseUrl: string | undefined;
let globalProtocol: Protocol | undefined;

export function resolveConfig(config: Record<string, unknown>): void {
  const rawUrl = config.baseUrl;
  if (rawUrl === undefined || rawUrl === null || rawUrl === "") {
    globalBaseUrl = undefined;
  } else if (typeof rawUrl !== "string") {
    throw new Error("custom baseUrl must be a string");
  } else {
    globalBaseUrl = normalizeBaseUrl(rawUrl);
  }
  const rawProtocol = config.protocol;
  if (rawProtocol === undefined || rawProtocol === null) {
    globalProtocol = undefined;
  } else if (isProtocol(rawProtocol)) {
    globalProtocol = rawProtocol;
  } else {
    throw new Error(
      `custom protocol must be one of ${PROTOCOLS.join(", ")} (got ${JSON.stringify(rawProtocol)})`,
    );
  }
}

export function globalSettings(): {
  baseUrl: string | undefined;
  protocol: Protocol | undefined;
} {
  return { baseUrl: globalBaseUrl, protocol: globalProtocol };
}
