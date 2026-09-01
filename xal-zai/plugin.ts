import { resolveBaseUrl } from "./config";
import { configureContext } from "./context";
import { zaiProvider } from "./provider";
import { configureRuntime } from "./runtime";
import type { Plugin } from "./types";

const plugin: Plugin = {
  name: "zai",
  register(ctx) {
    configureRuntime(ctx.runtime);
    resolveBaseUrl(ctx.config);
    configureContext(ctx.config);
    ctx.registerProvider(zaiProvider);
  },
};

export default plugin;
