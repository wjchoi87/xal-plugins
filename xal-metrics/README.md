# xal-metrics

Per-turn timing and usage metrics for [Xal](https://github.com/xal-sh/xal).

Observes XAL's normalized `Usage` and generic agent lifecycle events and shows
what is known — nothing else. No provider-specific code, no token estimates,
no configuration needed.

## Features

Base metrics (always available):

- Turn duration
- Input / output tokens
- Cache read / write and cache hit rate
- Tool count and tool timing

Enhanced metrics, enabled automatically when the XAL runtime supports the
stream hook:

- TTFT (first-text latency)
- TPS (from provider output tokens / generation duration)
- Stream stalls

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

Legacy:

```
6.4s · in 18.2K · out 621
6.4s · in 18.2K · out 621 · cache 92%
```

Stream-enabled:

```
TPS 72.4 · TTFT 1.3s · 6.4s · in 18.2K · out 621
TPS 72.4 · TTFT 1.3s · 6.4s · in 18.2K · out 621 · cache 92% · stall 2.1s×1
```

## Usage

Metrics are collected as turns complete, kept in memory (last 100 turns) and
persisted to `~/.xal/metrics/metrics.jsonl` (JSONL, one line per turn, mode
0600, trimmed to 5 MB by dropping the oldest quarter of lines).

```
/metrics                 list the 10 most recent turns, compact
/metrics last            most recent turn, detail
/metrics 3               third most recent turn, detail
/metrics session <id>    most recent turns of one session
```

Example detail view:

```
#1  claude-3-5-sonnet
Provider   anthropic
TTFT       1.28s
First evt  0.71s
Generation 5.13s
Turn       8.91s
TPS        72.4
Input      18,284
Cache read 16,902
Cache hit  92%
Tools      7
Tool time  2.14s
Stalls     1
Max stall  820ms
```

## Configuration

Optional, in `config.json` under `pluginConfig.metrics`:

```json
{
  "pluginConfig": {
    "metrics": {
      "enabled": true,
      "persistence": true,
      "stallThresholdMs": 1000
    }
  }
}
```

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
