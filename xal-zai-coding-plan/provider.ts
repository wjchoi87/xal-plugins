import type { Provider } from "./types";
import { connect } from "./auth";
import { defaultModel, listModels } from "./models";
import { streamResponse } from "./transport";

export const PROVIDER_ID = "zai-coding-plan";
export const PROVIDER_NAME = "Z.ai - Coding Plan";

export const zaiProvider: Provider = {
  id: PROVIDER_ID,
  name: PROVIDER_NAME,
  aliases: ["zai", "glm", "zhipu", "coding-plan"],
  capabilities: { imageInput: false },
  connect,
  listModels,
  defaultModel,
  stream: streamResponse,
};
