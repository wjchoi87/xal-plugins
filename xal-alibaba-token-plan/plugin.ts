import { resolveBaseUrl } from "./config";
import { alibabaTokenPlanProvider } from "./provider";
import { configureRuntime } from "./runtime";
import type { Plugin } from "./types";

const plugin: Plugin = {
  name: "alibaba-token-plan",
  register(ctx) {
    configureRuntime(ctx.runtime);
    resolveBaseUrl(ctx.config);
    ctx.registerProvider(alibabaTokenPlanProvider);
  },
};

export default plugin;
