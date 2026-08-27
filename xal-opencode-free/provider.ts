import type { Provider } from "./types";
import { connect } from "./auth";
import { defaultModel, listModels } from "./models";
import { streamResponse } from "./transport";

export const PROVIDER_ID = "opencode-free";
export const PROVIDER_NAME = "OpenCode Free";

export const openCodeFreeProvider: Provider = {
  id: PROVIDER_ID,
  name: PROVIDER_NAME,
  aliases: [],
  capabilities: { imageInput: true },
  connect,
  listModels,
  defaultModel,
  stream: streamResponse,
};
