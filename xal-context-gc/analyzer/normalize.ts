/*
 * Safe normalization (#10 in INSTRUCTION.md).
 *
 * Normalization is used ONLY for exact dedupe fingerprints and preview text.
 * Raw page storage always keeps the exact raw output. Never normalize source
 * code, lower-case, reorder lines, or canonicalize JSON.
 */

import { createHash } from "node:crypto";

/** ANSI CSI/OSC escape sequence matcher (deterministic, no state). */
const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

export interface NormalizeOptions {
  stripAnsi: boolean;
}

/**
 * Representation-level normalization allowed for exact dedupe (#10):
 * CRLF -> LF and optional ANSI stripping. Nothing else.
 */
export function normalizeForDedup(
  text: string,
  options: NormalizeOptions,
): string {
  let value = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (options.stripAnsi) value = stripAnsi(value);
  return value;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** UTF-8 byte length (deterministic, not token-based). */
export function countBytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Line count using LF line endings (matches recall's line model). */
export function countLines(text: string): number {
  if (text === "") return 0;
  return text.split("\n").length;
}

/**
 * Split raw text into lines preserving exact line content. A single trailing
 * newline does not create an extra empty line (common Unix file shape).
 */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  return text.split("\n");
}
