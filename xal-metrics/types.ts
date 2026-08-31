/*
 * XAL plugin API types.
 *
 * Snapshot from apps/cli (src/plugins/types.ts, src/hooks/types.ts,
 * src/providers/types.ts, src/commands/types.ts) that this plugin relies on.
 * Extended with the optional stream hook: XAL registers hooks by looking up
 * handler fields on the hook object, so older XAL versions that do not know
 * about `stream` simply ignore it and the remaining handlers keep working.
 */

export type JsonValue =
  string | number | boolean | null | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface Usage {
  totalInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
}

export type SessionKind = "primary" | "subagent";

export type PermissionMode = string;

export interface HookSession {
  id: string;
  kind: SessionKind;
  cwd: string;
  provider: string;
  profile: string;
  model: string;
  mode: PermissionMode;
}

export interface HookContext {
  session: HookSession;
  signal: AbortSignal;
}

export interface PromptHookInput {
  text: string;
  imageCount: number;
}

export type PromptHookResult =
  | { type: "replace"; text: string }
  | { type: "reject"; reason: string }
  | undefined;

export interface BeforeToolHookInput {
  callId: string;
  tool: string;
  args: JsonObject;
}

export type BeforeToolHookResult =
  | { type: "replace"; args: JsonObject }
  | { type: "block"; reason: string }
  | undefined;

export interface AfterToolHookInput extends BeforeToolHookInput {
  title: string;
  readOnly: boolean;
  output: string;
}

export type AfterToolHookResult =
  { type: "replace"; output: string } | undefined;

export interface TurnEndHookInput {
  output?: string | JsonObject;
  usage?: Usage;
  context?: Usage;
}

export interface ProviderReplay {
  provider: string;
  model?: string;
  data: JsonObject;
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

export type ProviderOutputItem =
  AssistantMessageItem | ReasoningItem | ToolCallItem;

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_summary_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "item_done"; item: ProviderOutputItem }
  | { type: "done"; usage?: Usage };

export interface StreamHookInput {
  event: StreamEvent;
}

type HookResult<T> = T | Promise<T>;

export interface Hook {
  name: string;
  prompt?(
    input: PromptHookInput,
    ctx: HookContext,
  ): HookResult<PromptHookResult>;
  stream?(input: StreamHookInput, ctx: HookContext): HookResult<void>;
  beforeTool?(
    input: BeforeToolHookInput,
    ctx: HookContext,
  ): HookResult<BeforeToolHookResult>;
  afterTool?(
    input: AfterToolHookInput,
    ctx: HookContext,
  ): HookResult<AfterToolHookResult>;
  turnEnd?(input: TurnEndHookInput, ctx: HookContext): HookResult<void>;
}

export interface AgentSession {
  id: string;
}

export interface CommandContext {
  session: AgentSession;
  print(line: string): void;
  busy(label?: string): void;
  restore(input: UserInput): void;
  ask(question: string): Promise<string | undefined>;
  askSecret(question: string): Promise<string | undefined>;
}

export interface Command {
  name: string;
  aliases?: string[];
  describe: string;
  hidden?: boolean;
  run(args: string[], ctx: CommandContext): Promise<void>;
}

export interface Plugin {
  name: string;
  register(ctx: PluginContext): void;
}

export interface PluginContext {
  config: Record<string, unknown>;
  runtime: { paths: { home: string; cache: string } };
  registerHook(hook: Hook): void;
  registerCommand(command: Command): void;
}

export interface UserInput {
  text: string;
  images: ImageInput[];
}

export interface ImageInput {
  mediaType: "image/png" | "image/jpeg";
  data: string;
}
