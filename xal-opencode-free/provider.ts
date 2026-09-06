import type { Provider, StreamEvent, StreamRequest } from "./types";
import { connect } from "./auth";
import { defaultModel, listModels } from "./models";
import { runWithOpenCodeSession } from "./session-context";
import { streamResponse } from "./transport";

export const PROVIDER_ID = "opencode-free";
export const PROVIDER_NAME = "OpenCode Free";

async function* streamWithSession(
  profileId: string,
  request: StreamRequest,
): AsyncGenerator<StreamEvent> {
  const iterator = streamResponse(profileId, request)[Symbol.asyncIterator]();
  while (true) {
    const step = await runWithOpenCodeSession(request.sessionId, () =>
      iterator.next(),
    );
    if (step.done) return;
    yield step.value;
  }
}

export const openCodeFreeProvider: Provider = {
  id: PROVIDER_ID,
  name: PROVIDER_NAME,
  aliases: [],
  capabilities: { imageInput: true },
  connect,
  listModels,
  defaultModel,
  stream: streamWithSession,
};
