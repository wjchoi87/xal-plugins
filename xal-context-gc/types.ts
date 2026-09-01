/*
 * XAL plugin API types.
 *
 * Snapshot from apps/cli (src/plugins/types.ts, src/hooks/types.ts,
 * src/commands/types.ts, src/agent/prompt/registry.ts, src/tools/types.ts)
 * that this plugin relies on. Only the public surface is used: no private
 * imports, no session internals (#3 in INSTRUCTION.md).
 *
 * registerPrompt + registerTool are part of the current public PluginContext
 * and confirmed against xal-sh/xal main.
 */

export type JsonValue =
  string | number | boolean | null | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
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

export type HookResult<T> = T | Promise<T>;

export interface Hook {
  name: string;
  prompt?(
    input: PromptHookInput,
    ctx: HookContext,
  ): HookResult<PromptHookResult>;
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

export interface TurnEndHookInput {
  output?: string | JsonObject;
  usage?: Usage;
  context?: Usage;
}

export interface Usage {
  totalInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
}

export interface PromptContext {
  sessionId: string;
  appName: string;
  platform: string;
  cwd: string;
  kind: SessionKind;
  mode: PermissionMode;
}

/** Static prompt section emitted into the system prompt (registry.ts). */
export interface PromptSection {
  id: string;
  text(ctx: PromptContext): string;
}

export interface ToolCallContext {
  cwd: string;
}

export interface ToolExecutionContext extends ToolCallContext {
  sessionId: string;
  sessionKind: SessionKind;
  directory: string;
  signal: AbortSignal;
  update(text: string): void;
}

export interface ToolResult {
  output: string;
}

/**
 * The minimal `Tool` contract used by context_gc_recall. Matches the public
 * `Tool` interface: a plugin-registered tool is called with
 * `ToolExecutionContext` and must return `{ output }`.
 */
export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  title(args: Record<string, unknown>, ctx: ToolCallContext): string;
  readOnly?(args: Record<string, unknown>, ctx: ToolCallContext): boolean;
  execute(
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult>;
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
  registerTool(tool: Tool): void;
  registerCommand(command: Command): void;
  registerHook(hook: Hook): void;
  registerPrompt(section: PromptSection): void;
}

export interface UserInput {
  text: string;
  images: ImageInput[];
}

export interface ImageInput {
  mediaType: "image/png" | "image/jpeg";
  data: string;
}
