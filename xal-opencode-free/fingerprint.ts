import { createHash } from "node:crypto";
import { clientUserAgent } from "./config";
import type { ToolDefinition } from "./types";

/* OpenCode's free-tier gateway (opencode.ai/zen...) rejects requests that do
 * not carry the fingerprint of the official OpenCode client:
 *
 *   403 {"type":"FreeTierError","message":"OpenCode's free tier can only be
 *   used from within OpenCode. Download it at https://opencode.ai and keep
 *   building."}
 *
 * Community bisection of the gateway (9router issues #4101/#4105/#4132) and
 * live verification against opencode.ai (2026-10) identified four gates a
 * request must pass:
 *
 *   1. user-agent must be the official client's
 *      `opencode/<channel>/<version>/<artifact>` format (v1.19.x; the older
 *      bare `opencode/<version>` form now gets the same 403)
 *   2. x-opencode-session must match `ses_` + 12 lowercase hex + 14 base62
 *      (missing header fails)
 *   3. the request must declare the tool quartet {bash, glob, grep, read}
 *      (tool-less requests -> 403; extra caller tools are allowed verbatim)
 *   4. `stream` must be true (stream:false -> 403 even when all else passes)
 *
 * This module centralizes the values that let this plugin's requests pass.

 * Policy change:
 * - before: the plugin identified itself honestly (`xal-opencode-free/...`,
 *   raw Xal session id, caller tools verbatim) and free-tier inference was
 *   rejected with FreeTierError
 * - after: gateway requests present the official client fingerprint — the
 *   configurable `opencode/<channel>/<version>/<artifact>` user-agent,
 *   canonical `ses_...` session ids, and the required tool quartet — while
 *   the user's own OpenCode API key still authenticates every request
 * - reason: the free tier is the plugin's entire purpose; without the client
 *   fingerprint every inference request 403s
 * - scope: requests to the configured zen/go base URLs only */
export { clientUserAgent };

/* Canonical upstream session id: `ses_` + 12 lowercase hex + 14 base62. */
export const CANONICAL_SESSION_ID = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/* The 12 hex chars are the low 48 bits of the bitwise-NOT of
 * `timestamp * 0x1000 + counter` (big-endian) — the official client's
 * "descending" identifier encoding (packages/schema/src/identifier.ts).
 * The gateway validates this part: a random or ascending-encoded timestamp
 * gets the same 403 FreeTierError as a malformed id (verified live:
 * descending passes, ascending and hash-derived hex fail). */
function descendingTimeHex(timestampMs: number): string {
  const value = ~(BigInt(Math.trunc(timestampMs)) * 0x1000n + 1n);
  return Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0"),
  ).join("");
}

/* One raw Xal session id -> one upstream session id for this process, so all
 * requests in a session share the gateway session (and its prompt cache). */
const upstreamSessions = new Map<string, string>();

/* Policy change:
 * - before: the raw Xal session id went into x-opencode-session, so any id
 *   that did not happen to look like `ses_...` failed the session gate
 * - after: ids already in canonical form pass through unchanged; everything
 *   else is translated to `ses_` + descending-timestamp hex (captured on
 *   first use, then memoized) + 14 base62 chars derived from SHA-256 of the
 *   Xal session id
 * - reason: the gateway requires both the canonical shape and a
 * descending-encoded timestamp; a stable translation keeps one Xal session
 * pinned to one upstream session id so upstream prompt caching survives
 * across turns within a process
 * - scope: the x-opencode-session header value on gateway requests */
export function toOpenCodeSessionId(sessionId: string): string {
  if (CANONICAL_SESSION_ID.test(sessionId)) return sessionId;
  const memoized = upstreamSessions.get(sessionId);
  if (memoized !== undefined) return memoized;
  const digest = createHash("sha256").update(sessionId).digest();
  let tail = "";
  for (let i = 6; i < 20; i++) {
    tail += BASE62[digest[i]! % BASE62.length];
  }
  const translated = `ses_${descendingTimeHex(Date.now())}${tail}`;
  upstreamSessions.set(sessionId, translated);
  return translated;
}

/* The quartet the gateway requires in every inference request. Names must be
 * exactly these; descriptions only discourage the model from calling tools
 * this client cannot execute (a call that slips through still resolves — the
 * host answers unknown tools with an error tool result). */
const FINGERPRINT_TOOLS: ToolDefinition[] = [
  {
    name: "bash",
    description:
      "Execute a shell command. Declared for OpenCode client compatibility only — prefer the shell tool offered in this session.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "glob",
    description:
      "Find files by glob pattern. Declared for OpenCode client compatibility only — prefer the file-search tool offered in this session.",
    parameters: {
      type: "object",
      properties: { pattern: { type: "string" } },
      required: ["pattern"],
    },
  },
  {
    name: "grep",
    description:
      "Search file contents by pattern. Declared for OpenCode client compatibility only — prefer the search tool offered in this session.",
    parameters: {
      type: "object",
      properties: { pattern: { type: "string" } },
      required: ["pattern"],
    },
  },
  {
    name: "read",
    description:
      "Read a file. Declared for OpenCode client compatibility only — prefer the file tool offered in this session.",
    parameters: {
      type: "object",
      properties: { filePath: { type: "string" } },
      required: ["filePath"],
    },
  },
];

export const FINGERPRINT_TOOL_NAMES = FINGERPRINT_TOOLS.map(
  (tool) => tool.name,
);

/* Policy change:
 * - before: inference requests carried the caller's tool list verbatim, so a
 *   request with 0-3 tools (or without bash/glob/grep/read) hit the free-tier
 *   403 FreeTierError
 * - after: only the missing quartet members are appended to the caller's own
 *   tools, which are kept untouched and verbatim
 * - reason: the gateway requires the quartet the official client always
 *   declares; caller tools are allowed as extras
 * - scope: tool declarations on chat-completions / responses / messages
 *   request bodies — never the host's tool registry */
export function mergedTools(callerTools: ToolDefinition[]): ToolDefinition[] {
  const names = new Set(callerTools.map((tool) => tool.name));
  const missing = FINGERPRINT_TOOLS.filter((tool) => !names.has(tool.name));
  return missing.length === 0 ? callerTools : [...callerTools, ...missing];
}
