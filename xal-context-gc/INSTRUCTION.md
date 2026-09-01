# xal-context-gc — Final Implementation Specification

> Plugin directory: `xal-context-gc`
>
> Plugin name: `context-gc`
>
> Target repository: `wjchoi87/xal-plugins`
>
> Primary goal:
>
> **Preserve everything required for the agent to finish its task while minimizing the cost of keeping everything else in model context.**

---

# 1. What this plugin is

`xal-context-gc` is an **agent-oriented context memory runtime**.

It is NOT:

- a generic conversation summarizer
- a human-facing chat cleaner
- an OMO/DCP port
- a compaction replacement
- an LLM-based relevance scorer

It exists only to improve the probability and speed of successful autonomous task completion.

The optimization priority is strict:

```text
1. Context Fidelity
2. Cache Efficiency
3. Context Efficiency
```

This is lexicographic, not a weighted average.

If an optimization can reduce context size but may damage task completion, do not apply it.

If an optimization preserves fidelity but destroys useful provider cache for little benefit, defer it.

Only after fidelity and cache behavior are safe should token reduction be maximized.

---

# 2. Design principle

Treat model context as **working memory**, not permanent storage.

```text
Canonical/recoverable data
        │
        │
        ▼
Backing Store
        │
        │ page fault / recall
        ▼
Model Working Context
```

The goal is not:

```text
delete old information
```

The goal is:

```text
keep expensive information out of the working set
while preserving exact recovery
```

The central rule is:

> **Do not destroy memory the agent may need. Page expensive memory out and make exact recovery cheap.**

---

# 3. XAL constraints verified against current main

Before coding, re-check the exact installed XAL revision.

Current public plugin API exposes:

```text
PluginContext
- registerHook
- registerTool
- registerCommand
- registerPrompt
- ...
```

Current official lifecycle hooks are:

```text
prompt
beforeTool
afterTool
turnEnd
```

There is currently no official generic plugin hook that receives and can replace:

```ts
StreamRequest.input: ConversationItem[]
```

immediately before each provider call.

Therefore plugin-only v1 cannot safely perform arbitrary retroactive historical mark/sweep.

Do NOT:

- patch XAL core
- monkey-patch AgentSession
- import private session internals
- hook private registries
- wrap provider HTTP traffic
- depend on undocumented object mutation

The plugin must work entirely through public plugin APIs.

---

# 4. Critical XAL execution order

Current XAL tool execution is effectively:

```text
tool.execute()
    │
    ▼
afterTool hooks
    │
    ▼
boundToolOutput()
    │
    ▼
tool_result committed into AgentSession history
```

This is ideal for **ingress GC**.

The plugin can replace an oversized/low-value tool output before that output becomes persistent model context.

Important: XAL already has native tool-output bounding:

```text
MAX_OUTPUT_BYTES = 50 KiB
MAX_OUTPUT_LINES = 2,000
```

If output exceeds the limit, XAL stores the full raw output to disk and places a bounded head/tail preview in history.

However `afterTool` runs BEFORE this native bounding.

Therefore when `xal-context-gc` replaces the raw output, XAL only sees the replacement.

So `xal-context-gc` must persist the original raw output itself before replacing it.

Do not assume XAL's native output file will still exist after replacement.

---

# 5. Why ingress GC is worth doing even though XAL already bounds output

XAL only bounds outputs above 50 KiB / 2,000 lines.

Examples currently entering context unchanged:

```text
grep result       28 KiB
test output       37 KiB
file read         42 KiB
git diff          31 KiB
search result     18 KiB
```

Repeated over many tool calls, these dominate agent context.

Even outputs above 50 KiB still consume up to roughly 50 KiB in the context after XAL's native bounding.

`xal-context-gc` should typically reduce appropriate outputs to a 2–8 KiB working representation while preserving exact raw retrieval.

Realistic target:

```text
conversation-heavy work         ~10–25% total context reduction
normal coding-agent work        ~30–50%
read/grep/test-heavy work       ~50–65%
extreme exploration/log work    potentially 60–75%
```

These are targets, not guarantees. Measure real sessions.

---

# 6. v1 architecture

```text
                     Tool Result
                         │
                         ▼
                 Context Analyzer
                         │
           ┌─────────────┼─────────────┐
           │             │             │
           ▼             ▼             ▼
       KEEP_RAW      KEEP_CORE        PAGE
                                         │
                        ┌────────────────┴───────────────┐
                        ▼                                ▼
                Exact backing store             Compact descriptor
                                                         │
                                                         ▼
                                                  Agent history
```

Later, if the agent needs omitted data:

```text
context_gc_recall
       │
       ▼
exact page lookup
       │
       ▼
bounded exact content appended to current context
```

This is virtual-memory paging for agent context.

---

# 7. Three optimization axes

## 7.1 Context Fidelity

Fidelity means:

> Can the agent still obtain every piece of information necessary to complete the task correctly?

It does NOT mean:

> Does the transcript still look natural to a human?

Rules:

- Raw paged information must be stored exactly.
- If storage fails, pass the original tool output unchanged.
- If classification is uncertain, pass the original unchanged.
- Never invent semantic summaries of code/logs in v1.
- Never remove user messages.
- Never remove assistant messages.
- Never remove unresolved error evidence without retaining actionable core.
- Never silently make an omitted page inaccessible.

Fidelity is a hard constraint.

---

## 7.2 Cache Efficiency

Provider prompt caching benefits from a stable prefix.

Therefore v1 must obey:

```text
once an optimized tool result enters history,
never rewrite it later
```

Good:

```text
A B [page:C] D E
A B [page:C] D E F
A B [page:C] D E F G
```

Bad:

```text
A B C D E
A B D E
A D E
```

Do not dynamically inject changing page inventories or GC statistics into the system prompt.

Use one short stable prompt section.

---

## 7.3 Context Efficiency

Remove or page data with poor information density.

High priority:

```text
large search results
large grep results
large file reads
successful build noise
successful test noise
large status/list output
repeated identical outputs
ANSI/progress noise
huge failure logs after actionable error core is retained
```

Low priority:

```text
small outputs
currently requested narrow file ranges
concise compiler errors
unresolved failures
unknown tool outputs where classification is uncertain
```

Age alone is NOT a GC signal in v1.

---

# 8. Context dispositions

Use:

```ts
type ContextDisposition =
  "KEEP_RAW" | "KEEP_CORE" | "PAGE" | "DEDUP_REF" | "TRIM_LOSSLESS" | "DEFER";
```

### KEEP_RAW

Preserve exactly in context.

Used when:

- small
- high-value
- already targeted
- uncertain
- paging benefit is negligible

### KEEP_CORE

Store raw output as a page but keep the actionable core directly in context.

Mostly for failures.

### PAGE

Store full raw output externally and replace model-facing output with descriptor + bounded exact preview.

### DEDUP_REF

When safe exact duplicate is detected, avoid carrying the same large content again.

### TRIM_LOSSLESS

Only remove representational noise that can be proven meaningless.

Examples:

- ANSI escape sequences
- repeated progress redraw frames
- exact duplicate blank lines where appropriate

Do not call semantic shortening "lossless".

### DEFER

Safety confidence or benefit is too low.

Equivalent to KEEP_RAW in v1 output behavior, but keep disposition separately for metrics/debugging.

---

# 9. Tool-aware classification

Do not implement one global `if output.length > threshold`.

The analyzer gets:

```ts
{
  (sessionId, callId, tool, args, title, readOnly, output);
}
```

and returns a deterministic decision.

---

## 9.1 File/read tools

Default policy:

```text
small/narrow read         KEEP_RAW
large read                PAGE
```

Descriptor metadata should include any path/range detectable from tool args.

Do not semantically summarize code.

A code page descriptor may include:

- path
- requested range
- total bytes
- total lines
- exact head preview
- page id
- recall instructions

If the agent explicitly requested a small line range, prefer KEEP_RAW.

---

## 9.2 grep/search/glob

High reclaimability.

Policy:

```text
small result                  KEEP_RAW
large result                  PAGE
exact repeated large result   DEDUP_REF
```

Descriptor should preserve:

- query if available
- result count if deterministically known
- exact bounded preview
- page id
- query recall instructions

---

## 9.3 shell/build/test

### Success

Large successful output is a strong PAGE candidate.

Keep directly:

```text
command outcome
bounded tail or meaningful exact final lines
explicit test count if directly present
```

Do not invent a test result by interpreting arbitrary text.

### Failure

Use KEEP_CORE.

Full raw log:

```text
PAGE
```

Actionable core stays directly in context.

Safe deterministic extraction includes:

- lines containing compiler diagnostics
- lines containing `error`, `failed`, `exception`, `panic`
- file:line diagnostics
- failing test identifiers
- bounded neighboring lines
- exit/error prefix if provided

Do not reduce a complex failure to:

```text
build failed
```

The agent must retain enough evidence not to repeat the same failed approach blindly.

---

## 9.4 Status/listing outputs

Repeated identical outputs are high-value DEDUP_REF candidates.

Examples:

```text
git status
git diff --stat
directory listing
package listing
```

Only exact dedupe in v1.

---

## 9.5 context_gc_recall

Never recursively page the plugin's own recall response.

The recall tool already enforces a bounded output.

---

# 10. Safe normalization

Before hashing for exact dedupe, only normalize representation-level noise.

Allowed:

- CRLF -> LF
- strip ANSI when configured
- optionally trim terminal progress-control artifacts with deterministic parser

Not allowed:

- whitespace normalization inside source code
- semantic line reordering
- lowercasing
- JSON canonicalization unless the tool output is known structured JSON and exact semantics are preserved
- fuzzy matching

Store BOTH:

```text
raw hash
safe-normalized hash
```

Raw page storage always contains exact raw output.

---

# 11. Page storage

Recommended root:

```text
<ctx.runtime.paths.home>/context-gc/
```

Layout:

```text
context-gc/
├── pages/
│   └── <session-id>/
│       ├── <page-id>.txt
│       └── index.jsonl
└── stats/
    └── <session-id>.json
```

Permissions:

```text
directories 0700
files       0600
```

Writes:

```text
tmp file
   ↓
fsync/close where practical
   ↓
atomic rename
```

If page persistence fails:

```text
KEEP_RAW
```

No exceptions may break the agent turn.

---

# 12. Page identity

```ts
interface ContextPage {
  id: string;
  sessionId: string;

  tool: string;
  callId: string;
  argsHash: string;

  createdAt: number;

  rawBytes: number;
  rawLines: number;

  rawSha256: string;
  normalizedSha256: string;

  storagePath: string;

  classification:
    "file" | "search" | "command" | "test" | "error" | "status" | "generic";

  title?: string;
  readOnly?: boolean;
}
```

Recommended page id:

```text
sha256(sessionId + callId + rawSha256).slice(0, 16)
```

Do not rely solely on random IDs.

---

# 13. Page descriptor

Descriptor must be compact and machine-oriented.

Example:

```text
[context-gc page=7ac1e90d3a2f4c91 tool=read raw=84.2KiB lines=2318]
Large tool output was paged losslessly.

Exact preview:
<bounded exact original content>

The omitted content is available exactly with context_gc_recall.
Use a query or line range; do not guess omitted content.
```

Do not include verbose explanations repeatedly.

Static behavior belongs in the system prompt.

Descriptor target:

```text
~1–4 KiB normally
up to ~8 KiB for failure core
```

---

# 14. Recall tool

Register:

```text
context_gc_recall
```

Arguments:

```ts
interface RecallArgs {
  page_id: string;

  start_line?: number;
  end_line?: number;

  query?: string;
  context_lines?: number;

  max_bytes?: number;
}
```

Retrieval modes:

### line range

```text
page_id + start_line/end_line
```

Returns exact original lines.

### literal query

```text
page_id + query
```

Returns matches with line numbers and bounded surrounding lines.

Regex may be postponed until needed.

Defaults:

```text
default max bytes: 12 KiB
hard max bytes:    32 KiB
```

Never allow unlimited page dumps into context.

If results exceed the bound, return a continuation hint.

Example:

```text
[context-gc recall page=... lines=410-520]
...
[truncated; request another range if needed]
```

---

# 15. Stable prompt section

Register one static prompt section.

Semantics:

```text
Some large tool outputs may be replaced with [context-gc page=...] descriptors.
The omitted raw output is preserved exactly.
When omitted information is necessary to complete the task, use context_gc_recall.
Never guess missing page content.
Prefer targeted query/range recall instead of retrieving an entire page.
```

Requirements:

- static across turns
- no current token count
- no page inventory
- no changing statistics
- no model-specific wording

This protects provider cache stability.

---

# 16. Exact deduplication

v1 supports exact/safe-normalized duplicate detection only.

Use per-session index:

```text
normalizedSha256 -> existing page id
```

If a new large result is equivalent:

```text
[context-gc duplicate page=... raw=31.5KiB]
This tool output is identical to previously paged content.
Recall the referenced page only if exact content is required.
```

Do not implement embedding or fuzzy dedupe in v1.

---

# 17. Failure memory

The plugin must prioritize behaviorally useful failure evidence.

Example raw:

```text
45 KiB npm test output
```

Context:

```text
[context-gc page=...]

Failure core:
- failing test names
- exact error line(s)
- exact file:line diagnostics
- bounded neighboring lines
```

Raw full log stays recoverable.

This avoids:

```text
failure
GC
same failed approach repeated
```

without carrying the entire log forever.

---

# 18. Native XAL output bounding interaction

Remember:

```text
afterTool GC
   ↓
XAL native boundToolOutput
```

If GC changes output to 3 KiB, XAL will not create its own 50 KiB bounded output file.

Therefore Context GC page persistence is authoritative for anything it replaces.

Do not create a second page if output is left KEEP_RAW; let XAL's own native bounding work normally.

Decision:

```text
KEEP_RAW
→ no Context GC storage
→ XAL may later native-bound if >50 KiB

PAGE / KEEP_CORE / DEDUP_REF
→ Context GC persists first
→ replaces output
→ XAL receives compact form
```

This avoids unnecessary duplicate disk storage.

---

# 19. Context pressure

v1 should NOT require context-window size.

Ingress GC is useful for:

```text
32K
64K
128K
256K
1M
```

The model window changes how valuable savings are, not whether paging is correct.

Do not build the first version around fixed percentages like 70%/90%.

Historical pressure-based sweep is out of scope until XAL exposes an official model-facing conversation transform.

---

# 20. Historical GC abstraction

Prepare the interface, but ship no-op by default.

```ts
interface HistoryGcAdapter {
  supported(): boolean;

  transform(
    input: ConversationItem[],
    context: HistoryGcContext,
  ): ConversationItem[];
}
```

Implementation in v1:

```text
NoopHistoryGcAdapter
```

If a future/current public XAL version officially exposes a conversation transform hook:

```text
PublicHistoryGcAdapter
```

may be implemented.

No core patch is permitted.

Historical GC rules, when supported in future:

- model-facing history only
- canonical session remains intact
- batch sweep, not constant rewriting
- task liveness > recency
- cache invalidation cost considered
- user constraints pinned
- unresolved evidence pinned
- reloadable/superseded tool data first
- no semantic summarization by default

---

# 21. GC statistics contract

Context GC owns authoritative GC statistics.

Write cumulative per-session stats to:

```text
<context-gc-root>/stats/<session-id>.json
```

Schema:

```ts
interface ContextGcStatsFile {
  version: 1;
  sessionId: string;
  updatedAt: number;

  observedBytes: number;
  emittedBytes: number;
  reclaimedBytes: number;

  outputsObserved: number;
  outputsPaged: number;
  outputsKeptRaw: number;

  pagesCreated: number;
  duplicateHits: number;
  recalls: number;

  failOpenCount: number;
  storeFailures: number;
}
```

Definitions:

```text
observedBytes
raw tool-output bytes seen by Context GC

emittedBytes
bytes returned by the afterTool hook to XAL
for outputs Context GC processed

reclaimedBytes
max(0, observedBytes - emittedBytes)
for modified outputs
```

Do NOT estimate tokens here.

Bytes are deterministic.

`xal-metrics` can optionally read this file and correlate it with actual provider token usage.

Use atomic updates.

---

# 22. Plugin command

Register:

```text
/context-gc
```

Default output:

```text
Context GC
observed     18.4 MB
emitted       6.1 MB
reclaimed    12.3 MB (66.8%)
paged        183
dedup         41
recalls       27
fail-open      0
```

Optional:

```text
/context-gc status
/context-gc cleanup
```

Cleanup must be conservative.

Never delete pages still referenced by resumable sessions unless the user explicitly requests destructive cleanup.

---

# 23. Configuration

Suggested:

```json
{
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
```

Mode semantics:

```text
conservative
- default
- highest fidelity
- uncertain -> KEEP_RAW

balanced
- lower paging thresholds
- still deterministic

aggressive
- reserved for future
- do NOT add semantic pruning merely to justify this mode
```

---

# 24. Suggested project structure

```text
xal-context-gc/
├── package.json
├── tsconfig.json
├── plugin.ts
├── config.ts
├── types.ts
├── prompt.ts
├── commands.ts
│
├── analyzer/
│   ├── classify.ts
│   ├── normalize.ts
│   ├── failure-core.ts
│   └── decide.ts
│
├── storage/
│   ├── page-store.ts
│   ├── index.ts
│   └── stats-store.ts
│
├── gc/
│   ├── ingress.ts
│   ├── descriptor.ts
│   ├── dedupe.ts
│   └── history-adapter.ts
│
├── tools/
│   └── recall.ts
│
└── test/
    ├── ingress.test.ts
    ├── recall.test.ts
    ├── dedupe.test.ts
    ├── failure.test.ts
    ├── native-boundary.test.ts
    ├── storage.test.ts
    ├── stats.test.ts
    └── integration.test.ts
```

Follow conventions already used by the other `xal-plugins`.

---

# 25. Plugin entry flow

Conceptual:

```ts
const plugin: Plugin = {
  name: "context-gc",

  register(ctx) {
    const config = parseConfig(ctx.config);
    if (!config.enabled) return;

    const stats = new StatsStore(...);
    const pages = new PageStore(...);
    const engine = new ContextGcEngine({ config, pages, stats });

    ctx.registerPrompt(createContextGcPrompt());

    ctx.registerTool(createRecallTool({
      pages,
      stats,
      config,
    }));

    ctx.registerHook({
      name: "context-gc",

      afterTool(input, hookCtx) {
        try {
          const result = engine.process({
            session: hookCtx.session,
            callId: input.callId,
            tool: input.tool,
            args: input.args,
            title: input.title,
            readOnly: input.readOnly,
            output: input.output,
          });

          if (!result.changed) return undefined;

          return {
            type: "replace",
            output: result.output,
          };
        } catch {
          stats.noteFailOpen(hookCtx.session.id);
          return undefined;
        }
      },
    });

    ctx.registerCommand(
      createContextGcCommand({ stats, pages })
    );
  },
};
```

Every code path must preserve fail-open behavior.

---

# 26. Plugin ordering

XAL executes hooks by plugin order from the configured plugin list.

Do NOT rely on:

```text
alphabetical plugin name
```

for ordering.

Context GC itself should not require any other plugin to run before/after it.

`xal-metrics` integration must not depend on observing the mutated `afterTool` output.

Use the stats-file contract instead.

This prevents plugin-order coupling.

---

# 27. Security/privacy

Raw tool outputs may contain secrets.

Use XAL-provided already-redacted hook output as the storage source.

Do not attempt to recover pre-redaction data.

Storage permissions:

```text
0700 dirs
0600 files
```

Do not expose absolute backing-store paths inside model descriptors unless needed.

Prefer opaque page IDs.

---

# 28. Tests — fidelity

Must pass:

```text
[ ] exact page storage/retrieval is byte-consistent for UTF-8 content
[ ] line-range recall returns exact original lines
[ ] query recall returns exact matching lines
[ ] page write failure passes original output unchanged
[ ] analyzer exception passes original unchanged
[ ] unknown/uncertain output is preserved
[ ] plugin restart can recall persisted page
[ ] failed build/test keeps actionable core
[ ] natural user/assistant conversation is untouched
[ ] plugin failure never fails agent turn
```

---

# 29. Tests — context efficiency

Must pass:

```text
[ ] 40 KiB grep output can be reduced below configured descriptor target
[ ] 40 KiB test output can be paged even though XAL native 50 KiB limiter would not trigger
[ ] 200 KiB output is paged before XAL native bounding
[ ] exact duplicate large result produces DEDUP_REF
[ ] small tool result remains unchanged
[ ] recall result is bounded and not recursively paged
```

---

# 30. Tests — cache safety

Must verify:

```text
[ ] system prompt is stable across turns
[ ] no dynamic GC state is inserted into system prompt
[ ] existing conversation items are never retroactively modified
[ ] page descriptors are immutable once committed
[ ] recall appends information instead of rewriting history
```

---

# 31. Tests — agent completion

Token reduction alone is not success.

Create integration scenarios:

### Scenario A

```text
large file read
→ paged
→ agent realizes omitted function needed
→ recall query/range
→ correct edit
→ tests pass
```

### Scenario B

```text
large failing test log
→ failure core retained
→ full log paged
→ agent fixes error
→ test passes
```

### Scenario C

```text
repeated grep/status/read loop
→ exact dedupe
→ context growth significantly reduced
→ task finishes
```

### Scenario D

```text
session exits
→ restart/resume
→ old page referenced in history
→ recall still works
```

### Scenario E

```text
forced Context GC storage/analyzer failure
→ agent receives untouched original output
→ task still continues
```

Success requirement:

```text
task success rate must not regress
while carried context decreases
```

---

# 32. Measure real benefit

Measure before/after on representative XAL sessions.

Record:

```text
task success
turn count
compaction count
turn input tokens
latest context input tokens
cache read tokens
cache write tokens
cache coverage
GC observed bytes
GC emitted bytes
GC reclaimed bytes
GC recalls
fail-open count
```

Do not judge the plugin solely by reclaimed bytes.

A good result is:

```text
same/better task success
+
lower current context footprint
+
fewer compactions
+
stable cache coverage
```

---

# 33. Do not implement in v1

Explicitly exclude:

- LLM-based relevance scoring
- vector DB
- embeddings
- semantic summarization
- semantic dedupe
- fuzzy source-code dedupe
- dynamic conversation rewriting
- user-message pruning
- assistant-message pruning
- task-graph inference
- provider-specific request interception
- XAL core changes
- private XAL imports
- cache manipulation hacks

Collect real data first.

---

# 34. Definition of done

v1 is complete when:

```text
1. installs like existing xal-plugins
2. requires zero XAL core changes
3. hooks afterTool
4. pages large/low-density tool output before it becomes history
5. stores raw paged content durably and exactly
6. exposes bounded exact context_gc_recall
7. performs exact duplicate suppression
8. preserves actionable failure evidence
9. fails open on every plugin error
10. keeps provider prefix history immutable
11. records deterministic per-session GC stats
12. survives XAL session restart/resume
13. has integration tests proving task completion with paged data
14. demonstrates measurable context reduction on real agent workloads
```

---

# 35. Final engineering principle

```text
Context Fidelity is the safety invariant.
Cache Efficiency determines when not to rewrite.
Context Efficiency determines what should not live in working memory.
```

For current XAL, the correct plugin-only implementation is:

```text
Ingress Paging
+ Exact Recall
+ Exact Deduplication
+ Failure-Core Preservation
+ Stable Prefix
+ Fail Open
```

Do not simulate a historical GC capability that the public XAL API does not expose.

If ingress paging already reduces compaction and context footprint enough, stop there.

Only consider historical mark/sweep when a future official public conversation-transform hook exists.
