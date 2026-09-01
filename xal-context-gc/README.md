# xal-context-gc

Agent-oriented context memory runtime for [Xal](https://github.com/xal-sh/xal).

Large/low-density tool outputs are paged out of model context **before** they
become history (ingress GC). The exact raw output is stored durably on disk and
retrieved on demand with the bounded `context_gc_recall` tool — virtual-memory
paging for agent context.

Optimization priority (lexicographic, non-negotiable):

```text
1. Context Fidelity — never destroy memory the agent may need
2. Cache Efficiency — never rewrite an already-committed prompt prefix
3. Context Efficiency — keep expensive output out of the working set
```

Everything is deterministic and fail-open: if classification is uncertain,
storage fails, or any code path throws, the agent receives the untouched
original output and the turn continues.

## Install

```bash
cd xal-context-gc
./install.sh
```

The installer copies the plugin into `$XAL_DIR/plugins/xal-context-gc`
(`$XAL_HOME`, or `~/.xal` by default) and registers it in `config.json`.
Restart Xal. No XAL core changes, no private imports, no monkey-patching.

## What happens

1. `afterTool` hook classifies every tool result (tool name + args + output).
2. Small, targeted, or uncertain outputs stay unchanged (`KEEP_RAW`/`DEFER`).
3. Large search/grep/file/status/test outputs are paged: the raw bytes are
   written exactly under `~/.xal/context-gc/pages/<session>/` and the model
   sees a compact immutable descriptor with a bounded exact preview.
4. Definite failures keep an actionable core in context (failing test names,
   exact diagnostics, `file:line` hits, bounded neighbors) while the full log
   is paged.
5. Exact duplicates (safe-normalized: CRLF/ANSI only) collapse to a reference.
6. When the agent needs omitted content it calls `context_gc_recall` with a
   page id and a line range or literal query. Results are bounded (12 KiB
   default, 32 KiB hard cap).

## Configuration

`config.json` → `pluginConfig."context-gc"`:

```json
{
  "pluginConfig": {
    "context-gc": {
      "enabled": true,
      "mode": "conservative",
      "genericPageThresholdBytes": 24576,
      "searchPageThresholdBytes": 12288,
      "filePageThresholdBytes": 24576,
      "commandPageThresholdBytes": 16384,
      "previewBytes": 4096,
      "recallDefaultBytes": 12288,
      "recallMaxBytes": 32768,
      "exactDedup": true,
      "stripAnsi": true,
      "persistence": true,
      "maxStorageMb": 2048,
      "debug": false
    }
  }
}
```

Modes:

- `conservative` (default): highest fidelity; any uncertain classification
  keeps the original output.
- `balanced`: same deterministic rules on lower thresholds (×0.5).
- `aggressive`: reserved; today only lowers thresholds further (×0.25). No
  semantic pruning is ever enabled by mode.

## Commands

```text
/context-gc                per-session stats (observed/emitted/reclaimed)
/context-gc status         detailed view for the current session
/context-gc cleanup        conservative report — deletes nothing
/context-gc cleanup <id>   destructive: deletes one session's pages after
                           typing the session id to confirm
```

## Storage layout

```text
~/.xal/context-gc/
├── pages/
│   └── <session-id>/
│       ├── <page-id>.txt     exact raw page (0600)
│       └── index.jsonl       page metadata (0700 dirs)
└── stats/
    └── <session-id>.json     cumulative GC stats (version 1)
```

Page ids are content-derived (`sha256(sessionId + callId + rawHash)[:16]`), not
random. Writes go through tmp file → fsync → atomic rename.

## Failure memory

A 45 KiB failed `npm test` log is never reduced to "build failed". The model
keeps the failure core (exact error lines, diagnostics, failing test names)
while the raw log is paged; the agent has enough evidence not to repeat the
same failed approach. Exact repeats of a failure are intentionally **not**
deduped — the repetition itself is evidence.

## Tests

```bash
bun install
bun run check     # typecheck + prettier
bun test          # 71 unit/integration tests
```

Coverage includes byte-consistent UTF-8 paging, exact recall, dedupe,
failure-core extraction, XAL native boundary (50 KiB) interaction, restart
persistence, and task-completion scenarios.

## Not in v1

LLM-based relevance scoring, embeddings/fuzzy dedupe, semantic summarization,
conversation rewriting, user/assistant message pruning, provider request
interception, and any XAL core or private-internal dependency. Historical
mark/sweep ships as a `NoopHistoryGcAdapter` until XAL exposes an official
model-facing conversation transform hook.
