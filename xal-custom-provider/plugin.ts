import { resolveConfig } from "./config";
import { customProvider } from "./provider";
import { configureRuntime } from "./runtime";
import type { Plugin } from "./types";

const plugin: Plugin = {
  name: "custom",
  register(ctx) {
    configureRuntime(ctx.runtime);
    resolveConfig(ctx.config);
    ctx.registerProvider(customProvider);
  },
};

export default plugin;
