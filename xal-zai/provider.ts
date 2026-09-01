import type { Provider } from "./types";
import { connect } from "./auth";
import { defaultModel, listModels } from "./models";
import { streamResponse } from "./transport";

export const PROVIDER_ID = "zai";
export const PROVIDER_NAME = "Z.ai GLM";

export const zaiProvider: Provider = {
  id: PROVIDER_ID,
  name: PROVIDER_NAME,
  aliases: ["zai", "glm", "zhipu"],
  capabilities: { imageInput: true },
  connect,
  listModels,
  defaultModel,
  stream: streamResponse,
};
