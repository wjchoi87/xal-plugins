import type { Provider } from "./types";
import { connect } from "./auth";
import { defaultModel, listModels } from "./models";
import { streamResponse } from "./transport";

export const PROVIDER_ID = "commandcode-bridge";
export const PROVIDER_NAME = "Command Code";

export const commandCodeProvider: Provider = {
  id: PROVIDER_ID,
  name: PROVIDER_NAME,
  aliases: [],
  capabilities: { imageInput: true },
  connect,
  listModels,
  defaultModel,
  stream: streamResponse,
};
