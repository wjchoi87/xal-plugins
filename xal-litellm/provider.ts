import type { Provider } from "./types";
import { connect } from "./auth";
import { defaultModel, listModels } from "./models";
import { streamResponse } from "./transport";

export const PROVIDER_ID = "litellm";
export const PROVIDER_NAME = "LiteLLM";

export const litellmProvider: Provider = {
  id: PROVIDER_ID,
  name: PROVIDER_NAME,
  aliases: ["litellm"],
  capabilities: { imageInput: true },
  connect,
  listModels,
  defaultModel,
  stream: streamResponse,
};
