import { AsyncLocalStorage } from "node:async_hooks";

const sessionStorage = new AsyncLocalStorage<string>();

export function currentOpenCodeSessionId(): string | undefined {
  return sessionStorage.getStore();
}

export function runWithOpenCodeSession<T>(
  sessionId: string,
  callback: () => T,
): T {
  return sessionStorage.run(sessionId, callback);
}
