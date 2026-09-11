import type { ClientRuntime } from "./types";

let runtime: ClientRuntime | undefined;

export function configureRuntime(value: ClientRuntime): void {
  runtime = value;
}

export function clientRuntime(): ClientRuntime {
  if (!runtime) throw new Error("plugin runtime is not configured");
  return runtime;
}
