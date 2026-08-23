import { resolveBaseUrl } from "./config";
import { ollamaProvider } from "./provider";
import type { Plugin } from "./types";

const plugin: Plugin = {
  name: "ollama",
  register(ctx) {
    resolveBaseUrl(ctx.config);
    ctx.registerProvider(ollamaProvider);
  },
};

export default plugin;
