# xal-metrics

Per-turn timing and usage metrics for [Xal](https://github.com/xal-sh/xal).

Observes XAL's normalized `Usage` and generic agent lifecycle events and shows
what is known — nothing else. No provider-specific code, no token estimates,
no configuration needed.

## Features

Base metrics (always available):

- Turn duration
- Turn input / output tokens (whole-turn provider aggregate)
- Current context input (latest provider round's footprint, from `turnEnd.context`)
- Cache read / write and cache coverage
- Tool count and tool timing

Enhanced metrics, enabled automatically when the XAL runtime supports the
stream hook:

- TTFT (first-text latency)
- TPS (from provider output tokens / generation duration)
- Stream stalls

Context GC integration, enabled automatically (configurable):

- Per-turn Context GC deltas read from `xal-context-gc`'s cumulative session
  stats (`<home>/context-gc/stats/<session-id>.json`)
- Estimated GC-reclaimed context tokens, estimated context size without GC,
  paged outputs, dedup hits, recalls and fail-open count in the detail view
- Estimates are derived at ~4 bytes/token and always shown with a `~` prefix
- Fully fail-open: absent stats file, malformed JSON or invalid deltas simply
  produce no GC metrics

## Terminology

These three concepts are distinct and must not be confused:

| Concept              | Meaning                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Turn Input           | Aggregate provider input across the entire XAL turn (`turnEnd.usage`) — a tool-heavy turn can make several provider calls                                                                        |
| Context Input        | The latest provider round's input footprint (`turnEnd.context`) — the actual current model-facing context size                                                                                   |
| Cache Coverage       | Fraction of reported input tokens read from provider cache; **token cache coverage, not request HIT/MISS rate**                                                                                  |
| Context GC Reclaimed | Byte reduction performed by `xal-context-gc` before output enters history; the UI shows it as an **estimated** token figure (`~4 bytes/token`, always `~`-prefixed) — never an exact token count |

XAL does not expose request-level cache HIT/MISS events through the public
hook API, so this plugin never claims them.

## Compatibility

| XAL version         | Behavior                                         |
| ------------------- | ------------------------------------------------ |
| Without stream hook | Base metrics automatically                       |
| With stream hook    | Enhanced metrics automatically, no config change |

Capability detection is implicit: hook registration is field-lookup based, so
older XAL simply never invokes the `stream` handler. There is no version
string check and no `streamMetrics: true` switch — if the capability exists,
it is used.

Nothing unavailable is ever shown. There are no `N/A`, `unsupported` or `0%`
placeholders.

## Examples

Compact — `ctx` is the current context footprint, `in`/`out` are turn
aggregates, `cache` is turn-level token cache coverage:

```
6.4s · in 18.2K · out 621
TPS 72.4 · TTFT 1.3s · 6.4s · ctx 118K · in 243K · out 1.2K · cache 89% · gc ~18K
```

`gc ~18K` is the **estimated** context tokens reclaimed by Context GC this
turn (reclaimed bytes ÷ ~4 bytes/token), hidden when nothing was reclaimed.

Detail — turn usage, current context and Context GC are separate sections;
empty sections are omitted:

```
#1  claude-3-5-sonnet
Provider   anthropic

TTFT       1.28s
First evt  0.71s
Generation 5.13s
Turn       8.91s
TPS        72.4

Turn usage
  Input       243,210
  Output        1,203
  Cache read  215,420
  Cache write  22,310
  Cache cov      88.6%

Context
  Input       118,440
  Cache read  111,302
  Cache write   4,801
  Cache cov      94.0%

Context GC
  GC saved     ~18,374
  Without GC   ~136,814
  Paged          3
  Dedup          1
  Recalls        1

Tools      7
Tool time  2.14s
Stalls     1
Max stall  820ms
```

`GC saved` is an estimate (reclaimed bytes ÷ ~4 bytes/token); `Without GC`
adds it to the current context input (118,440 + 18,374). The `~` prefix marks
every estimated figure. Exact byte counts stay in the persisted metrics but
are not shown in the UI.

`Cache cov = cacheReadTokens / totalInputTokens` — the fraction of input
tokens served from the provider cache, not a request hit rate.

## Usage

Metrics are collected as turns complete, kept in memory (last 100 turns) and
persisted to `~/.xal/metrics/metrics.jsonl` (JSONL, one line per turn, mode
0600, trimmed to 5 MB by dropping the oldest quarter of lines). New context
and GC fields are optional additions; old records keep parsing/displaying.

```
/metrics                 list the 10 most recent turns, compact
/metrics last            most recent turn, detail
/metrics 3               third most recent turn, detail
/metrics session <id>    most recent turns of one session
```

## Configuration

Optional, in `config.json` under `pluginConfig.metrics`:

```json
{
  "pluginConfig": {
    "metrics": {
      "enabled": true,
      "persistence": true,
      "stallThresholdMs": 1000,
      "contextGcIntegration": true
    }
  }
}
```

`contextGcIntegration` defaults to `true`. When Context GC is not installed
the stats file is simply absent and no GC section is shown — no extra
configuration needed. Set it to `false` to skip reading the stats files.

Defaults work with no configuration at all.

## Privacy

Only timing and usage metadata is stored. Prompts, assistant responses, tool
arguments, tool output and credentials are never saved, and nothing is ever
transmitted anywhere — local-first.

## Known limitations

- XAL's plugin API exposes no extension point for rendering metadata next to
  assistant messages (`registerUi` replaces the whole UI; `ToolRenderer` only
  customizes tool blocks). The `/metrics` command is therefore the UI surface.
- The plugin API does not expose the terminal width, so no responsive
  shrinking of the compact line is attempted.
- Context-window usage (`ctx 63K/372K`) needs the model context window, which
  the plugin API does not provide; it is not estimated or hard-coded per
  provider.
- Request-level cache HIT/MISS is not observable through the public hook API;
  only turn and context token cache coverage are reported.
- Context GC savings are reported as byte-reclaim deltas converted with a
  fixed ~4 bytes/token estimate; the `~` figures are not exact token counts,
  and the exact bytes remain available in the persisted metrics only.

## Install

```bash
cd xal-plugins
./install.sh            # pick xal-metrics, or
cd xal-metrics && ./install.sh
```

Restart Xal afterward.

## Development

```bash
bun install
bun run check          # tsc --noEmit && prettier --check
bun test               # unit tests with a fake clock
```
