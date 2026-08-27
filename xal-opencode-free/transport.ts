import { providerFetch, raiseForStatus } from "./api";
import { apiKey } from "./auth";
import {
  parseProviderModelId,
  resolveEndpoint,
  type TransportKind,
} from "./model-sources";
import { PROVIDER_ID, PROVIDER_NAME } from "./provider";
import {
  asNumber,
  asString,
  isJsonObject,
  isRecord,
  ProviderError,
  type ConversationItem,
  type JsonObject,
  type ProviderOutputItem,
  type ProviderReplay,
  type ReasoningItem,
  type StreamEvent,
  type StreamRequest,
  type ToolCallItem,
  type ToolDefinition,
  type Usage,
} from "./types";

const USER_AGENT = "xal-opencode-free/0.1.0";
const DEFAULT_MAX_TOKENS = 32_000;

/* Without wall-clock model metadata the catalog doesn't advertise a protocol,
 * so we default to the OpenAI-compatible chat-completions endpoint. Per-model
 * overrides can opt individual free models onto /responses or /messages. */
const MODEL_TRANSPORT: Record<string, TransportKind> = {};

export type SseEvent = { done: true } | { done: false; data: unknown };

export async function* sseEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = (buffer + decoder.decode(value, { stream: true })).replaceAll(
        "\r\n",
        "\n",
      );
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (!data) continue;
        if (data === "[DONE]") {
          yield { done: true };
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          throw new ProviderError(`malformed SSE data: ${data.slice(0, 200)}`, {
            retryable: true,
          });
        }
        yield { done: false, data: parsed };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function streamError(
  name: string,
  error: unknown,
  signal?: AbortSignal,
): never {
  if (
    signal?.aborted ||
    (error instanceof Error && error.name === "AbortError")
  )
    throw error;
  if (error instanceof ProviderError) throw error;
  throw new ProviderError(`${name} stream failed: ${String(error)}`, {
    retryable: true,
  });
}

function parseToolArgs(
  providerName: string,
  toolName: string,
  argumentsText: string,
): JsonObject {
  let args: unknown;
  try {
    args = JSON.parse(argumentsText);
  } catch {
    throw new ProviderError(
      `${providerName} tool call ${toolName} had invalid JSON arguments`,
      { retryable: false },
    );
  }
  if (!isJsonObject(args)) {
    throw new ProviderError(
      `${providerName} tool call ${toolName} arguments were not an object`,
      { retryable: false },
    );
  }
  return args;
}

function replay(
  providerId: string,
  model: string,
  data: JsonObject,
): ProviderReplay {
  return { provider: providerId, model, data };
}

function reasoningItem(
  providerId: string,
  model: string,
  reasoning: string,
): ReasoningItem {
  return {
    type: "reasoning",
    summary: reasoning,
    replay: replay(providerId, model, { reasoning }),
  };
}

function assistantItem(
  providerId: string,
  model: string,
  text: string,
): ProviderOutputItem {
  return {
    type: "assistant_message",
    text,
    replay: replay(providerId, model, { content: text }),
  };
}

function toolCallItem(
  providerId: string,
  providerName: string,
  model: string,
  callId: string,
  name: string,
  argumentsText: string,
): ToolCallItem {
  return {
    type: "tool_call",
    callId,
    name,
    args: parseToolArgs(providerName, name, argumentsText),
    replay: replay(providerId, model, {
      id: callId,
      type: "function",
      function: { name, arguments: argumentsText },
    }),
  };
}

function resolveTransport(source: string, upstreamId: string): TransportKind {
  const explicit = MODEL_TRANSPORT[`${source}/${upstreamId}`];
  return explicit ?? "chat-completions";
}

async function openCodeFetch(
  endpoint: string,
  body: string,
  profileId: string,
  signal?: AbortSignal,
): Promise<Response> {
  const response = await providerFetch(PROVIDER_NAME, signal, endpoint, {
    method: "POST",
    headers: {
      accept: "text/event-stream",
      "content-type": "application/json",
      authorization: `Bearer ${await apiKey(profileId)}`,
      "user-agent": USER_AGENT,
    },
    body,
    signal,
  });
  if (!response.ok) await raiseForStatus(PROVIDER_NAME, response);
  return response;
}

/* ---------------- chat-completions transport ---------------- */

function buildChatMessages(
  instructions: string,
  items: ConversationItem[],
  imageInput: boolean,
): JsonObject[] {
  const messages: JsonObject[] = [{ role: "system", content: instructions }];
  let assistant: JsonObject | undefined;

  const currentAssistant = (): JsonObject => {
    assistant ??= { role: "assistant", content: "" };
    return assistant;
  };
  const flushAssistant = (): void => {
    if (!assistant) return;
    messages.push(assistant);
    assistant = undefined;
  };

  for (const item of items) {
    switch (item.type) {
      case "user_message":
        flushAssistant();
        if (item.images.length === 0 || !imageInput) {
          messages.push({ role: "user", content: item.text });
        } else {
          const content: JsonObject[] = [];
          if (item.text) content.push({ type: "text", text: item.text });
          for (const image of item.images) {
            content.push({
              type: "image_url",
              image_url: {
                url: `data:${image.mediaType};base64,${image.data}`,
              },
            });
          }
          messages.push({ role: "user", content });
        }
        break;
      case "assistant_message":
        currentAssistant().content = item.text;
        break;
      case "reasoning":
        currentAssistant().reasoning_content = item.summary;
        break;
      case "tool_call": {
        const message = currentAssistant();
        const calls = Array.isArray(message.tool_calls)
          ? message.tool_calls
          : [];
        calls.push({
          id: item.callId,
          type: "function",
          function: { name: item.name, arguments: JSON.stringify(item.args) },
        });
        message.tool_calls = calls;
        break;
      }
      case "tool_result":
        flushAssistant();
        messages.push({
          role: "tool",
          tool_call_id: item.callId,
          content: item.output,
        });
        break;
    }
  }
  flushAssistant();
  return messages;
}

function toolDefinitions(tools: ToolDefinition[]) {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function parseUsage(raw: unknown): Usage | undefined {
  if (!isRecord(raw)) return undefined;
  const promptDetails = isRecord(raw.prompt_tokens_details)
    ? raw.prompt_tokens_details
    : undefined;
  return {
    totalInputTokens: asNumber(raw.prompt_tokens),
    cacheReadInputTokens:
      asNumber(raw.prompt_cache_hit_tokens) ??
      (promptDetails ? asNumber(promptDetails.cached_tokens) : undefined),
    outputTokens: asNumber(raw.completion_tokens),
  };
}

interface ToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
}

function parseChatChunk(raw: unknown):
  | {
      text?: string;
      reasoning?: string;
      toolCalls: ToolCallDelta[];
      finishReason?: string;
      usage?: Usage;
    }
  | undefined {
  if (!isRecord(raw)) return undefined;
  if (isRecord(raw.error)) {
    throw new ProviderError(
      asString(raw.error.message) ?? `${PROVIDER_NAME} stream failed`,
      {
        retryable: true,
      },
    );
  }
  const usage = parseUsage(raw.usage);
  if (!Array.isArray(raw.choices) || raw.choices.length === 0) {
    return usage ? { toolCalls: [], usage } : undefined;
  }
  const choice = raw.choices[0];
  if (!isRecord(choice) || !isRecord(choice.delta)) return undefined;
  const deltas = Array.isArray(choice.delta.tool_calls)
    ? choice.delta.tool_calls
    : [];
  const toolCalls = deltas.flatMap((entry): ToolCallDelta[] => {
    if (!isRecord(entry)) return [];
    const index = asNumber(entry.index);
    if (index === undefined) return [];
    const fn = isRecord(entry.function) ? entry.function : undefined;
    return [
      {
        index,
        id: asString(entry.id),
        name: fn ? asString(fn.name) : undefined,
        arguments: fn ? asString(fn.arguments) : undefined,
      },
    ];
  });
  return {
    text: asString(choice.delta.content),
    reasoning:
      asString(choice.delta.reasoning_content) ??
      asString(choice.delta.reasoning),
    toolCalls,
    finishReason: asString(choice.finish_reason),
    usage,
  };
}

async function* streamChat(
  endpoint: string,
  profileId: string,
  request: StreamRequest,
  upstreamId: string,
): AsyncGenerator<StreamEvent> {
  const body = JSON.stringify({
    /* Upstream expects the bare catalog id (e.g. "deepseek-v4-flash-free"),
     * not the Xal-facing "zen/<id>" provider id. */
    model: upstreamId,
    messages: buildChatMessages(request.instructions, request.input, true),
    stream: true,
    stream_options: { include_usage: true },
    ...(request.thinking ? { reasoning_effort: request.thinking } : {}),
    ...(request.tools.length === 0
      ? {}
      : {
          tools: toolDefinitions(request.tools),
          tool_choice: request.toolChoice,
        }),
  });
  const response = await openCodeFetch(
    endpoint,
    body,
    profileId,
    request.signal,
  );
  if (!response.body)
    throw new ProviderError(`${PROVIDER_NAME} response had no body`, {
      retryable: true,
    });

  let text = "";
  let reasoning = "";
  let usage: Usage | undefined;
  let terminal = false;
  let finishReason: string | undefined;
  const calls = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();

  try {
    for await (const raw of sseEvents(response.body)) {
      if (raw.done) {
        terminal = true;
        break;
      }
      const chunk = parseChatChunk(raw.data);
      if (!chunk) continue;
      if (chunk.text) {
        text += chunk.text;
        yield { type: "text_delta", text: chunk.text };
      }
      if (chunk.reasoning) {
        reasoning += chunk.reasoning;
        yield { type: "reasoning_summary_delta", text: chunk.reasoning };
      }
      if (chunk.usage) usage = chunk.usage;
      if (chunk.finishReason) finishReason = chunk.finishReason;
      for (const delta of chunk.toolCalls) {
        const call = calls.get(delta.index) ?? {
          id: "",
          name: "",
          arguments: "",
        };
        if (delta.id) call.id += delta.id;
        if (delta.name) call.name += delta.name;
        if (delta.arguments) call.arguments += delta.arguments;
        calls.set(delta.index, call);
      }
    }
  } catch (error) {
    streamError(PROVIDER_NAME, error, request.signal);
  }

  if (!terminal)
    throw new ProviderError(`${PROVIDER_NAME} stream ended unexpectedly`, {
      retryable: true,
    });
  if (finishReason === "length") {
    throw new ProviderError(
      `${PROVIDER_NAME} response exceeded its output limit`,
      { retryable: false },
    );
  }
  if (reasoning)
    yield {
      type: "item_done",
      item: reasoningItem(PROVIDER_ID, request.model, reasoning),
    };
  if (text)
    yield {
      type: "item_done",
      item: assistantItem(PROVIDER_ID, request.model, text),
    };
  for (const call of [...calls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => call)) {
    if (!call.id || !call.name) {
      throw new ProviderError(
        `${PROVIDER_NAME} returned an incomplete tool call`,
        { retryable: false },
      );
    }
    yield {
      type: "item_done",
      item: toolCallItem(
        PROVIDER_ID,
        PROVIDER_NAME,
        request.model,
        call.id,
        call.name,
        call.arguments,
      ),
    };
  }
  yield { type: "done", usage };
}

/* ---------------- responses transport ---------------- */

function buildResponsesBody(
  request: StreamRequest,
  upstreamId: string,
): string {
  return JSON.stringify({
    /* Upstream expects the bare catalog id, not the "zen/<id>" provider id. */
    model: upstreamId,
    store: false,
    stream: true,
    instructions: request.instructions,
    input: buildResponseInput(request.input),
    ...(request.tools.length === 0
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            strict: false,
          })),
          tool_choice: request.toolChoice,
          parallel_tool_calls: true,
        }),
  });
}

function buildResponseInput(items: ConversationItem[]): JsonObject[] {
  return items.flatMap((item): JsonObject[] => {
    switch (item.type) {
      case "user_message":
        return [
          {
            role: "user",
            content: [
              ...(item.text ? [{ type: "input_text", text: item.text }] : []),
              ...item.images.map((image) => ({
                type: "input_image",
                image_url: `data:${image.mediaType};base64,${image.data}`,
              })),
            ],
          },
        ];
      case "assistant_message":
        return [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: item.text }],
          },
        ];
      case "reasoning":
        return [];
      case "tool_call":
        return [
          {
            type: "function_call",
            call_id: item.callId,
            name: item.name,
            arguments: JSON.stringify(item.args),
          },
        ];
      case "tool_result":
        return [
          {
            type: "function_call_output",
            call_id: item.callId,
            output: item.output,
          },
        ];
    }
  });
}

function responsesUsage(raw: unknown): Usage | undefined {
  if (!isRecord(raw)) return undefined;
  const inputDetails = isRecord(raw.input_tokens_details)
    ? raw.input_tokens_details
    : undefined;
  return {
    totalInputTokens: asNumber(raw.input_tokens),
    cacheReadInputTokens: inputDetails
      ? asNumber(inputDetails.cached_tokens)
      : undefined,
    cacheWriteInputTokens: inputDetails
      ? asNumber(inputDetails.cache_write_tokens)
      : undefined,
    outputTokens: asNumber(raw.output_tokens),
  };
}

type WireSseEvent =
  | { type: "output_text_delta"; delta: string }
  | { type: "reasoning_summary_delta"; delta: string }
  | { type: "item_done"; item: JsonObject }
  | { type: "terminal"; usage?: Usage }
  | { type: "failure"; message: string; retryable: boolean };

function parseResponsesEvent(raw: unknown): WireSseEvent | undefined {
  if (!isRecord(raw)) return undefined;
  const type = asString(raw.type);
  if (!type) return undefined;
  switch (type) {
    case "response.output_text.delta": {
      const delta = asString(raw.delta);
      return delta === undefined
        ? undefined
        : { type: "output_text_delta", delta };
    }
    case "response.reasoning_summary_text.delta": {
      const delta = asString(raw.delta);
      return delta === undefined
        ? undefined
        : { type: "reasoning_summary_delta", delta };
    }
    case "response.output_item.done":
      return isJsonObject(raw.item)
        ? { type: "item_done", item: raw.item }
        : failure("response item was not valid JSON");
    case "response.completed":
    case "response.done": {
      const usageRaw = isRecord(raw.response) ? raw.response.usage : undefined;
      return usageRaw
        ? { type: "terminal", usage: responsesUsage(usageRaw) }
        : { type: "terminal" };
    }
    case "response.failed":
      return failure("response failed");
    case "error":
      return failure(asString(raw.message) ?? "stream error");
    default:
      return undefined;
  }
}

function failure(message: string, retryable = true): WireSseEvent {
  return { type: "failure", message, retryable };
}

function parseResponsesItem(
  item: JsonObject,
  model: string,
): ProviderOutputItem | undefined {
  switch (asString(item.type)) {
    case "message": {
      const text = Array.isArray(item.content)
        ? (item.content as JsonObject[])
            .filter((block) => asString(block.type) === "output_text")
            .map((block) => asString(block.text) ?? "")
            .join("")
        : "";
      return {
        type: "assistant_message",
        text,
        replay: replay(PROVIDER_ID, model, item),
      };
    }
    case "reasoning":
      return {
        type: "reasoning",
        summary: "",
        replay: replay(PROVIDER_ID, model, item),
      };
    case "function_call": {
      const callId = asString(item.call_id);
      const name = asString(item.name);
      const argumentsText = asString(item.arguments);
      if (!callId || !name || argumentsText === undefined)
        return {
          type: "assistant_message",
          text: "",
          replay: replay(PROVIDER_ID, model, item),
        };
      return {
        type: "tool_call",
        callId,
        name,
        args: parseToolArgs(PROVIDER_NAME, name, argumentsText),
        replay: replay(PROVIDER_ID, model, item),
      };
    }
    default:
      return undefined;
  }
}

async function* streamResponses(
  endpoint: string,
  profileId: string,
  request: StreamRequest,
  upstreamId: string,
): AsyncGenerator<StreamEvent> {
  const response = await openCodeFetch(
    endpoint,
    buildResponsesBody(request, upstreamId),
    profileId,
    request.signal,
  );
  if (!response.body)
    throw new ProviderError(`${PROVIDER_NAME} response had no body`, {
      retryable: true,
    });
  let terminal = false;
  try {
    for await (const raw of sseEvents(response.body)) {
      if (raw.done) continue;
      const event = parseResponsesEvent(raw.data);
      if (!event) continue;
      switch (event.type) {
        case "output_text_delta":
          yield { type: "text_delta", text: event.delta };
          break;
        case "reasoning_summary_delta":
          yield { type: "reasoning_summary_delta", text: event.delta };
          break;
        case "item_done": {
          const item = parseResponsesItem(event.item, request.model);
          if (item) yield { type: "item_done", item };
          break;
        }
        case "terminal":
          terminal = true;
          yield { type: "done", usage: event.usage };
          break;
        case "failure":
          throw new ProviderError(event.message, {
            retryable: event.retryable,
          });
      }
      if (terminal) break;
    }
  } catch (error) {
    streamError(PROVIDER_NAME, error, request.signal);
  }
  if (!terminal)
    throw new ProviderError(`${PROVIDER_NAME} stream ended unexpectedly`, {
      retryable: true,
    });
}

/* ---------------- anthropic-messages transport ---------------- */

function buildAnthropicBody(
  request: StreamRequest,
  upstreamId: string,
): string {
  return JSON.stringify({
    /* Upstream expects the bare catalog id, not the "zen/<id>" provider id. */
    model: upstreamId,
    max_tokens: DEFAULT_MAX_TOKENS,
    stream: true,
    system: [{ type: "text", text: request.instructions }],
    messages: buildAnthropicMessages(request.input),
    ...(request.tools.length === 0
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters,
          })),
        }),
  });
}

function buildAnthropicMessages(items: ConversationItem[]): JsonObject[] {
  const messages: JsonObject[] = [];
  let assistant: JsonObject[] = [];
  const flushAssistant = (): void => {
    if (assistant.length === 0) return;
    messages.push({ role: "assistant", content: assistant });
    assistant = [];
  };
  const pushUser = (content: JsonObject[]): void => {
    const last = messages.at(-1);
    if (last && last.role === "user" && Array.isArray(last.content)) {
      last.content = [...last.content, ...content];
      return;
    }
    messages.push({ role: "user", content });
  };
  for (const item of items) {
    switch (item.type) {
      case "user_message": {
        flushAssistant();
        const blocks: JsonObject[] = item.images.map((image) => ({
          type: "image",
          source: {
            type: "base64",
            media_type: image.mediaType,
            data: image.data,
          },
        }));
        if (item.text) blocks.push({ type: "text", text: item.text });
        pushUser(
          blocks.length ? blocks : [{ type: "text", text: "(empty message)" }],
        );
        break;
      }
      case "reasoning":
        break;
      case "assistant_message":
        if (item.text) assistant.push({ type: "text", text: item.text });
        break;
      case "tool_call":
        assistant.push({
          type: "tool_use",
          id: item.callId,
          name: item.name,
          input: item.args,
        });
        break;
      case "tool_result":
        flushAssistant();
        pushUser([
          {
            type: "tool_result",
            tool_use_id: item.callId,
            content: item.output,
          },
        ]);
        break;
    }
  }
  flushAssistant();
  return messages;
}

async function* streamAnthropic(
  endpoint: string,
  profileId: string,
  request: StreamRequest,
  upstreamId: string,
): AsyncGenerator<StreamEvent> {
  const response = await openCodeFetch(
    endpoint,
    buildAnthropicBody(request, upstreamId),
    profileId,
    request.signal,
  );
  if (!response.body)
    throw new ProviderError(`${PROVIDER_NAME} response had no body`, {
      retryable: true,
    });

  const open = new Map<
    number,
    {
      type: string;
      id: string;
      name: string;
      text: string;
      partialJson: string;
    }
  >();
  let usage: Usage | undefined;
  let terminal = false;
  try {
    for await (const raw of sseEvents(response.body)) {
      if (raw.done) continue;
      const event = parseAnthropicEvent(raw.data);
      if (!event) continue;
      switch (event.type) {
        case "usage":
          usage = event.usage;
          break;
        case "block_start":
          open.set(event.index, {
            type: asString(event.block.type) ?? "",
            id: asString(event.block.id) ?? "",
            name: asString(event.block.name) ?? "",
            text: "",
            partialJson: "",
          });
          break;
        case "text_delta": {
          const block = open.get(event.index);
          if (block) block.text += event.text;
          yield { type: "text_delta", text: event.text };
          break;
        }
        case "thinking_delta":
          yield { type: "reasoning_summary_delta", text: event.text };
          break;
        case "input_json_delta": {
          const block = open.get(event.index);
          if (block) block.partialJson += event.partial;
          break;
        }
        case "block_stop": {
          const block = open.get(event.index);
          open.delete(event.index);
          if (!block) continue;
          if (block.type === "tool_use") {
            const callId = block.id;
            const name = block.name;
            if (!callId || !name)
              throw new ProviderError(
                `${PROVIDER_NAME} returned an incomplete tool call`,
                { retryable: false },
              );
            yield {
              type: "item_done",
              item: toolCallItem(
                PROVIDER_ID,
                PROVIDER_NAME,
                request.model,
                callId,
                name,
                block.partialJson || "{}",
              ),
            };
          } else if (block.type === "text" && block.text) {
            yield {
              type: "item_done",
              item: assistantItem(PROVIDER_ID, request.model, block.text),
            };
          }
          break;
        }
        case "terminal":
          if (event.outputTokens !== undefined)
            usage = { ...usage, outputTokens: event.outputTokens };
          break;
        case "message_stop":
          terminal = true;
          break;
        case "failure":
          throw new ProviderError(event.message, {
            retryable: event.retryable,
          });
      }
      if (terminal) break;
    }
  } catch (error) {
    streamError(PROVIDER_NAME, error, request.signal);
  }
  if (!terminal)
    throw new ProviderError(`${PROVIDER_NAME} stream ended unexpectedly`, {
      retryable: true,
    });
  yield { type: "done", usage };
}

type AnthropicEvent =
  | { type: "usage"; usage: Usage }
  | { type: "block_start"; index: number; block: JsonObject }
  | { type: "text_delta"; index: number; text: string }
  | { type: "thinking_delta"; index: number; text: string }
  | { type: "input_json_delta"; index: number; partial: string }
  | { type: "block_stop"; index: number }
  | { type: "terminal"; outputTokens?: number }
  | { type: "message_stop" }
  | { type: "failure"; message: string; retryable: boolean };

function parseAnthropicEvent(raw: unknown): AnthropicEvent | undefined {
  if (!isRecord(raw)) return undefined;
  const type = asString(raw.type);
  if (!type) return undefined;
  switch (type) {
    case "message_start": {
      const usageRaw = isRecord(raw.message) ? raw.message.usage : undefined;
      if (!isRecord(usageRaw)) return undefined;
      const cacheRead = asNumber(usageRaw.cache_read_input_tokens) ?? 0;
      const cacheWrite = asNumber(usageRaw.cache_creation_input_tokens) ?? 0;
      const input = asNumber(usageRaw.input_tokens) ?? 0;
      return {
        type: "usage",
        usage: {
          totalInputTokens: input + cacheRead + cacheWrite,
          cacheReadInputTokens: cacheRead,
          cacheWriteInputTokens: cacheWrite,
          outputTokens: asNumber(usageRaw.output_tokens),
        },
      };
    }
    case "content_block_start": {
      const index = asNumber(raw.index);
      if (index === undefined || !isJsonObject(raw.content_block))
        return undefined;
      return { type: "block_start", index, block: raw.content_block };
    }
    case "content_block_delta": {
      const index = asNumber(raw.index);
      if (index === undefined || !isRecord(raw.delta)) return undefined;
      switch (asString(raw.delta.type)) {
        case "text_delta": {
          const text = asString(raw.delta.text);
          return text === undefined
            ? undefined
            : { type: "text_delta", index, text };
        }
        case "thinking_delta": {
          const text = asString(raw.delta.thinking);
          return text === undefined
            ? undefined
            : { type: "thinking_delta", index, text };
        }
        case "input_json_delta": {
          const partial = asString(raw.delta.partial_json);
          return partial === undefined
            ? undefined
            : { type: "input_json_delta", index, partial };
        }
        default:
          return undefined;
      }
    }
    case "content_block_stop": {
      const index = asNumber(raw.index);
      return index === undefined ? undefined : { type: "block_stop", index };
    }
    case "message_delta": {
      const outputTokens = isRecord(raw.usage)
        ? asNumber(raw.usage.output_tokens)
        : undefined;
      return { type: "terminal", outputTokens };
    }
    case "message_stop":
      return { type: "message_stop" };
    case "error":
      return {
        type: "failure",
        message: `${PROVIDER_NAME} stream error`,
        retryable: true,
      };
    default:
      return undefined;
  }
}

/* ---------------- router ---------------- */

export async function* streamResponse(
  profileId: string,
  request: StreamRequest,
): AsyncGenerator<StreamEvent> {
  const parsed = parseProviderModelId(request.model);
  if (!parsed) {
    throw new ProviderError(
      `${PROVIDER_NAME} received an invalid model id: ${request.model}`,
      {
        retryable: false,
      },
    );
  }
  const transport = resolveTransport(parsed.source, parsed.upstreamId);
  const endpoint = resolveEndpoint(parsed.source, transport);
  switch (transport) {
    case "responses":
      yield* streamResponses(endpoint, profileId, request, parsed.upstreamId);
      return;
    case "anthropic-messages":
      yield* streamAnthropic(endpoint, profileId, request, parsed.upstreamId);
      return;
    case "chat-completions":
      yield* streamChat(endpoint, profileId, request, parsed.upstreamId);
      return;
  }
}
