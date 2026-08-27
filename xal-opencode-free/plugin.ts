import { resolveConfig } from "./config";
import { debugCommand } from "./command";
import { openCodeFreeProvider } from "./provider";
import { configureRuntime } from "./runtime";
import type { Plugin } from "./types";

const plugin: Plugin = {
  name: "opencode-free",
  register(ctx) {
    configureRuntime(ctx.runtime);
    resolveConfig(ctx.config);
    ctx.registerProvider(openCodeFreeProvider);
    ctx.registerCommand(debugCommand);
  },
};

export default plugin;
