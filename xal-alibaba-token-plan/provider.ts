import type { Provider } from "./types";
import { connect } from "./auth";
import { defaultModel, listModels } from "./models";
import { streamResponse } from "./transport";

export const PROVIDER_ID = "alibaba-token-plan";
export const PROVIDER_NAME = "Alibaba Token Plan";

export const alibabaTokenPlanProvider: Provider = {
  id: PROVIDER_ID,
  name: PROVIDER_NAME,
  aliases: ["ali-token"],
  capabilities: { imageInput: true },
  connect,
  listModels,
  defaultModel,
  stream: streamResponse,
};
