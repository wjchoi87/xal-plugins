import { resolveBaseUrl } from "./config";
import { litellmProvider } from "./provider";
import { configureRuntime } from "./runtime";
import type { Plugin } from "./types";

const plugin: Plugin = {
  name: "litellm",
  register(ctx) {
    configureRuntime(ctx.runtime);
    resolveBaseUrl(ctx.config);
    ctx.registerProvider(litellmProvider);
  },
};

export default plugin;
