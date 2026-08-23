import { resolveBaseUrl } from "./config";
import { commandCodeProvider } from "./provider";
import { configureRuntime } from "./runtime";
import type { Plugin } from "./types";

const plugin: Plugin = {
  name: "commandcode-bridge",
  register(ctx) {
    configureRuntime(ctx.runtime);
    resolveBaseUrl(ctx.config);
    ctx.registerProvider(commandCodeProvider);
  },
};

export default plugin;
