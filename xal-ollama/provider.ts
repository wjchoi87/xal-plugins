import type { Provider } from "./types";
import { connect } from "./auth";
import { defaultModel, listModels } from "./models";
import { streamResponse } from "./transport";

export const PROVIDER_ID = "ollama";
export const PROVIDER_NAME = "Ollama";

export const ollamaProvider: Provider = {
  id: PROVIDER_ID,
  name: PROVIDER_NAME,
  aliases: ["ollama"],
  capabilities: { imageInput: true },
  connect,
  listModels,
  defaultModel,
  stream: streamResponse,
};
