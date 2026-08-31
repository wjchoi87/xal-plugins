export type JsonValue =
  string | number | boolean | null | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export interface ProviderReplay {
  provider: string;
  model?: string;
  data: JsonObject;
}

export interface ImageInput {
  mediaType: "image/png" | "image/jpeg";
  data: string;
}

export interface UserMessageItem {
  type: "user_message";
  text: string;
  images: ImageInput[];
  messageId?: string;
  modelText?: string;
}

export interface AssistantMessageItem {
  type: "assistant_message";
  text: string;
  replay?: ProviderReplay;
}

export interface ReasoningItem {
  type: "reasoning";
  summary: string;
  replay?: ProviderReplay;
}

export interface ToolCallItem {
  type: "tool_call";
  callId: string;
  name: string;
  args: JsonObject;
  replay?: ProviderReplay;
}

export interface ToolResultItem {
  type: "tool_result";
  callId: string;
  output: string;
}

export type ProviderOutputItem =
  AssistantMessageItem | ReasoningItem | ToolCallItem;
export type ConversationItem =
  UserMessageItem | ProviderOutputItem | ToolResultItem;
export type ModelInputModality = "text" | "image";
export type ThinkingEffort =
  "none" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ThinkingOptions {
  options: ThinkingEffort[];
  default: ThinkingEffort;
}

export interface ModelInfo {
  id: string;
  name: string;
  contextWindow?: number;
  /* Selectable context windows, ascending; the first entry must equal
   * `contextWindow`. When absent, Xal reports the model as not supporting
   * configurable context windows. */
  contextWindows?: number[];
  inputModalities: ModelInputModality[];
  thinking?: ThinkingOptions;
}

export interface ModelCatalog {
  models: ModelInfo[];
  source: "runtime" | "cache" | "bundled";
  warning?: string;
}

export interface Usage {
  totalInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_summary_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "item_done"; item: ProviderOutputItem }
  | { type: "done"; usage?: Usage };

export interface StreamRequest {
  instructions: string;
  tools: ToolDefinition[];
  cacheKey: string;
  model: string;
  conversationModel?: string;
  thinking?: ThinkingEffort;
  input: ConversationItem[];
  toolChoice: "auto" | "none";
  sessionId: string;
  signal?: AbortSignal;
}

export interface ConnectChoice {
  label: string;
  detail: string;
}

export interface ConnectContext {
  print(line: string): void;
  select(choices: ConnectChoice[]): Promise<number | undefined>;
  askSecret?(question: string): Promise<string | undefined>;
}

export interface ApiKeyCredential {
  type: "api_key";
  key: string;
}

export type Credential = ApiKeyCredential;

export interface Provider {
  id: string;
  name: string;
  aliases: string[];
  capabilities: { imageInput: boolean };
  connect?(ctx: ConnectContext): Promise<Credential | undefined>;
  listModels(profileId: string, refresh: boolean): Promise<ModelCatalog>;
  defaultModel(profileId: string): Promise<string>;
  stream(profileId: string, request: StreamRequest): AsyncIterable<StreamEvent>;
}

export interface ClientRuntime {
  app: { name: string; version: string };
  paths: { home: string; cache: string };
  credentials: {
    load(
      providerId: string,
      profileId: string,
    ): Promise<Credential | undefined>;
  };
  protectSecret(value: string): void;
}

export interface PluginContext {
  config: Record<string, unknown>;
  runtime: ClientRuntime;
  registerProvider(provider: Provider): void;
}

export interface Plugin {
  name: string;
  register(ctx: PluginContext): void;
}

export interface ProviderErrorOptions {
  retryable: boolean;
  retryAfterMs?: number;
}

export class ProviderError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(message: string, options: ProviderErrorOptions) {
    super(message);
    this.name = "ProviderError";
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs;
  }
}
