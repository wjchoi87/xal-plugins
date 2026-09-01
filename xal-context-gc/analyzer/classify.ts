/*
 * Tool-aware classification (#9 in INSTRUCTION.md).
 *
 * The analyzer never uses one global output-size rule. Each tool is assigned
 * a family from its name, args shape and title; unknown tools fall back to
 * "generic" where the decision layer stays conservative.
 *
 * Only predictable names are listed. Everything unlisted remains generic
 * (uncertain -> preserved unchanged in conservative mode).
 */

export type ToolFamily =
  "file" | "search" | "status" | "command" | "recall" | "generic";

/** Tools whose output is a read of file content (paths/ranges). */
const FILE_TOOLS = new Set([
  "read",
  "read_file",
  "readfile",
  "view",
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "show",
  "inspect",
  "open",
  "display",
  "preview",
]);

/** Tools whose output is a search/glob/find result. */
const SEARCH_TOOLS = new Set([
  "grep",
  "rg",
  "ripgrep",
  "search",
  "glob",
  "find",
  "ag",
  "ack",
  "locate",
  "code_search",
  "search_files",
  "grep_files",
]);

/** Tools whose output is a status/listing snapshot. */
const STATUS_TOOLS = new Set([
  "list",
  "ls",
  "status",
  "git_status",
  "diff",
  "git_diff",
  "log",
  "dir",
  "tree",
  "stat",
  "last_updated",
]);

/** Shell/command execution tools. */
const COMMAND_TOOLS = new Set([
  "bash",
  "sh",
  "zsh",
  "shell",
  "exec",
  "run",
  "execute",
  "terminal",
  "cmd",
  "powershell",
  "pwsh",
  "command",
  "run_command",
  "run_test",
  "test",
]);

/** Tools that definitely mutate state; their results are not pageable. */
const WRITE_TOOLS = new Set([
  "write",
  "edit",
  "patch",
  "apply_patch",
  "insert",
  "sed",
  "mv",
  "cp",
  "rm",
  "mkdir",
  "touch",
  "delete",
  "remove",
  "rename",
  "create",
  "append",
  "unlink",
  "git_commit",
  "commit",
]);

export interface ToolMeta {
  family: ToolFamily;
  isWrite: boolean;
  /** Detected target path (file reads/edits, cwd-based commands). */
  path?: string;
  /** Detected decodable line range from args (1-based). */
  range?: { start?: number; end?: number };
  /** True when the read explicitly requested a narrow line range. */
  explicitNarrowRange: boolean;
  query?: string;
  command?: string;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function extractRange(args: Record<string, unknown>): ToolMeta["range"] {
  const start = args.start_line ?? args.startLine ?? args.offset;
  const end = args.end_line ?? args.endLine;
  const range: { start?: number; end?: number } = {};
  if (typeof start === "number" && Number.isInteger(start) && start >= 1) {
    range.start = start;
  }
  if (typeof end === "number" && Number.isInteger(end) && end >= 1) {
    range.end = end;
  }
  return range.start !== undefined || range.end !== undefined
    ? range
    : undefined;
}

function isNarrowRange(range: ToolMeta["range"]): boolean {
  if (!range) return false;
  if (range.start !== undefined && range.end !== undefined) {
    return range.end - range.start + 1 <= 200;
  }
  if (range.start !== undefined) return range.start >= 1_000_000; // tail-style reads
  return range.end !== undefined && range.end <= 200;
}

export function classifyTool(
  tool: string,
  args: Record<string, unknown>,
  title: string,
): ToolMeta {
  const lower = tool.toLowerCase();
  const isWrite = WRITE_TOOLS.has(lower);

  let family: ToolFamily;
  if (lower === "context_gc_recall" || lower === "context-gc-recall") {
    family = "recall";
  } else if (FILE_TOOLS.has(lower)) {
    family = "file";
  } else if (SEARCH_TOOLS.has(lower)) {
    family = "search";
  } else if (STATUS_TOOLS.has(lower)) {
    family = "status";
  } else if (COMMAND_TOOLS.has(lower)) {
    family = "command";
  } else {
    family = "generic";
  }

  const path = firstString(
    args.path,
    args.file_path,
    args.filePath,
    args.target,
  );
  const query = firstString(args.query, args.pattern, args.regex, args.term);
  const command = firstString(args.command, args.cmd, args.command_line);
  const range = extractRange(args);
  const explicitNarrowRange = isNarrowRange(range);

  // search/status via shell commands: keep them in their effective family
  if (family === "command" && command !== undefined) {
    if (
      /^(find|grep|rg|rgrep|ls|ls -|tree|git status|git diff|git log|git ls)/.test(
        command.trim(),
      )
    ) {
      family = /^(ls\b|tree\b|git status|git diff|git log|git ls)/.test(
        command.trim(),
      )
        ? "status"
        : "search";
    }
  }

  return {
    family,
    isWrite,
    path,
    range,
    explicitNarrowRange,
    query,
    command,
  };
}
