import { baseUrl } from "./config";
import { providerFetch, raiseForStatus } from "./api";
import { apiKey } from "./auth";
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
  type ReasoningItem,
  type StreamEvent,
  type StreamRequest,
  type ToolCallItem,
  type ToolDefinition,
  type Usage,
} from "./types";

export type SseEvent = { done: true } | { done: false; data: unknown };

async function* sseEvents(
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
          throw new Error(`malformed SSE data: ${data.slice(0, 200)}`);
        }
        yield { done: false, data: parsed };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseToolArgs(toolName: string, argumentsText: string): JsonObject {
  let args: unknown;
  try {
    args = JSON.parse(argumentsText);
  } catch {
    throw new ProviderError(
      `${PROVIDER_NAME} tool call ${toolName} had invalid JSON arguments`,
      { retryable: false },
    );
  }
  if (!isJsonObject(args)) {
    throw new ProviderError(
      `${PROVIDER_NAME} tool call ${toolName} arguments were not an object`,
      { retryable: false },
    );
  }
  return args;
}

function assistantMessage(): JsonObject {
  return { role: "assistant", content: "" };
}

function buildMessages(
  instructions: string,
  items: ConversationItem[],
): JsonObject[] {
  const messages: JsonObject[] = [{ role: "system", content: instructions }];
  let assistant: JsonObject | undefined;

  const currentAssistant = (): JsonObject => {
    assistant ??= assistantMessage();
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
        messages.push({ role: "user", content: item.text });
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

function parseUsage(raw: unknown): Usage | undefined {
  if (!isRecord(raw)) return undefined;
  return {
    totalInputTokens: asNumber(raw.prompt_tokens),
    outputTokens: asNumber(raw.completion_tokens),
  };
}

interface ToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
}

interface PendingToolCall {
  id: string;
  name: string;
  arguments: string;
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
      { retryable: true },
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

function replay(
  providerId: string,
  model: string,
  data: JsonObject,
): { provider: string; model: string; data: JsonObject } {
  return { provider: providerId, model, data };
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
  model: string,
  callId: string,
  name: string,
  argumentsText: string,
): ToolCallItem {
  return {
    type: "tool_call",
    callId,
    name,
    args: parseToolArgs(name, argumentsText),
    replay: replay(providerId, model, {
      id: callId,
      type: "function",
      function: { name, arguments: argumentsText },
    }),
  };
}

function reasoningItem(
  providerId: string,
  model: string,
  reasoning: string,
): ReasoningItem {
  return {
    type: "reasoning",
    summary: reasoning,
    replay: replay(providerId, model, {
      reasoning,
    }),
  };
}
export async function* streamResponse(
  profileId: string,
  request: StreamRequest,
): AsyncGenerator<StreamEvent> {
  const providerId = PROVIDER_ID;
  const model = request.model;
  const body = JSON.stringify({
    model: request.model,
    messages: buildMessages(request.instructions, request.input),
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
  const response = await providerFetch(
    PROVIDER_NAME,
    request.signal,
    `${baseUrl()}/chat/completions`,
    {
      method: "POST",
      headers: {
        accept: "text/event-stream",
        "content-type": "application/json",
        authorization: `Bearer ${await apiKey(profileId)}`,
        "user-agent": "xal-alibaba-token-plan/0.1.0",
      },
      body,
      signal: request.signal,
    },
  );
  if (!response.ok) await raiseForStatus(PROVIDER_NAME, response);
  if (!response.body)
    throw new ProviderError(`${PROVIDER_NAME} response had no body`, {
      retryable: true,
    });

  let text = "";
  let reasoning = "";
  let usage: Usage | undefined;
  let terminal = false;
  let finishReason: string | undefined;
  const calls = new Map<number, PendingToolCall>();

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
    if (request.signal?.aborted || error instanceof ProviderError) throw error;
    throw new ProviderError(
      `${PROVIDER_NAME} stream failed: ${String(error)}`,
      { retryable: true },
    );
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
  yield { type: "done", usage };

  if (reasoning)
    yield {
      type: "item_done",
      item: reasoningItem(providerId, model, reasoning),
    };
  if (text)
    yield { type: "item_done", item: assistantItem(providerId, model, text) };
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
      item: toolCallItem(providerId, model, call.id, call.name, call.arguments),
    };
  }
}
