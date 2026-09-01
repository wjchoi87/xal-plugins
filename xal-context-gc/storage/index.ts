/*
 * Storage utilities (#11 in INSTRUCTION.md).
 *
 * Layout under <runtime.paths.home>/context-gc:
 *   pages/<session-id>/<page-id>.txt   exact raw page
 *   pages/<session-id>/index.jsonl     page metadata index
 *   stats/<session-id>.json            cumulative GC statistics
 *
 * Directories 0700, files 0600. Writes go through a tmp file + fsync +
 * atomic rename so a crash never leaves a torn page or stats file.
 */

import { mkdir, open, rename } from "node:fs/promises";
import { dirname } from "node:path";

export const CONTEXT_GC_DIR = "context-gc";
export const PAGE_FILE_MODE = 0o600;
export const DIR_MODE = 0o700;

export interface AtomicWriteOptions {
  mode?: number;
}

/** Atomic write: tmp file -> fsync -> rename into place. */
export async function atomicWriteFile(
  path: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const mode = options.mode ?? PAGE_FILE_MODE;
  await mkdir(dirname(path), { recursive: true, mode: DIR_MODE });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const handle = await open(tmp, "w", mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
}

/** Append a JSON line to a JSONL index (best-effort atomicity is fine). */
export async function appendJsonlLine(
  path: string,
  value: unknown,
): Promise<void> {
  const handle = await open(path, "a", PAGE_FILE_MODE);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}
