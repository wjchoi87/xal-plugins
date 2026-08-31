/* Shared test helpers: fake clock (#40) and session fixtures. */

import type { Clock } from "../../metrics/collector";
import type { HookSession } from "../../types";

export function fakeClock(
  start = 0,
  wall = 1_700_000_000_000,
): Clock & { advance(ms: number): void } {
  let value = start;
  let wallValue = wall;
  return {
    now: () => value,
    wallNow: () => wallValue,
    advance(ms: number) {
      value += ms;
      wallValue += ms;
    },
  };
}

export function session(
  id = "session-a",
  overrides: Partial<HookSession> = {},
): HookSession {
  return {
    id,
    kind: "primary",
    cwd: "/tmp/project",
    provider: "anthropic",
    profile: "default",
    model: "claude-x",
    mode: "yolo",
    ...overrides,
  };
}
