import type { Provider, StreamEvent, StreamRequest } from "./types";
import { connect } from "./auth";
import { defaultModel, listModels } from "./models";
import { runWithOpenCodeSession } from "./session-context";
import { streamResponse } from "./transport";

export const PROVIDER_ID = "opencode-free";
export const PROVIDER_NAME = "OpenCode Free";

/* Policy change:
 * - before: only iterator.next() ran in the session context; early consumer
 *   exits left the inner iterator suspended and its response reader locked.
 * - after: every exit also closes the inner iterator in the same session.
 * - reason: preserve transport cleanup when consumers break or throw.
 * - scope: Go and Zen streams, including normal completion and errors. */
async function* streamWithSession(
  profileId: string,
  request: StreamRequest,
): AsyncGenerator<StreamEvent> {
  const iterator = streamResponse(profileId, request)[Symbol.asyncIterator]();
  try {
    while (true) {
      const step = await runWithOpenCodeSession(request.sessionId, () =>
        iterator.next(),
      );
      if (step.done) return;
      yield step.value;
    }
  } finally {
    await runWithOpenCodeSession(request.sessionId, () =>
      iterator.return(undefined),
    );
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
