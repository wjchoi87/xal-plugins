# xal-opencode-free

OpenCode Free provider plugin for [Xal](https://github.com/xal-sh/xal). It exposes **only** the models OpenCode currently serves for free on **OpenCode Zen Free**.

Paid Zen models never appear, and **OpenCode Go models are excluded entirely** — every Go catalog entry (including the `*-free` ones) is served only while a Go plan subscription is active, so none of them belong in a free-models provider. The free set is driven by the live OpenCode catalog, so new free models show up on `/models` refresh without a plugin update.

## Automatic model metadata sync

OpenCode's `/models` catalog lists only model IDs. Everything else the plugin needs — each model's display name, context limit, whether it has been retired, and which protocol it is served on — is synced at runtime from [models.dev](https://models.dev) (`opencode` = Zen), the same metadata OpenCode's own client uses. No plugin update or reinstall is needed when OpenCode changes a model:

| upstream change                                                  | what the plugin does                                                    |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| new free model / changed context limit                           | uses the published `limit.context` for compaction and `/context-window` |
| new free model name                                              | shows the official name (e.g. `Nemotron 3.5 Super VL (Zen Free)`)       |
| model marked `status = "deprecated"`                             | hides it from `/models` (reason `upstream-deprecated`)                  |
| model served on `/responses`/`/messages`                         | routes requests to that endpoint automatically                          |
| model on a protocol the plugin can't stream (System One, Gemini) | hides it (reason `unsupported-protocol`)                                |

- Synced with the catalog, cached for **12 hours** (`modelMetadataTtlMs`); `/models` refresh forces a re-sync.
- Only the OpenCode entries are kept (a few KB, `<runtime-cache>/opencode-free/models-dev-metadata.json`). Your OpenCode API key is never sent to models.dev.
- If models.dev is unreachable the last synced snapshot is used, then the bundled tables below.

## What "FREE" means here

FREE means a model that OpenCode currently serves on Zen without a separate token charge (i.e. an explicitly free / free-preview model).

It does **not** mean:

- unlimited usage
- no rate limits
- always online
- any SLA
- a free preview that will never end

FREE is determined **fail-closed**: if we cannot be confident a model is free, it is excluded. `UNKNOWN != FREE`.

## ⚠️ Go models are excluded

OpenCode Go is a paid subscription, and even its `*-free` / free-preview models are served **only while a Go plan subscription is active**. The plugin therefore does not query the Go catalog at all and never exposes `go/<id>` models.

## Install

Clone the repo, then run this plugin's installer:

```bash
git clone https://github.com/wjchoi87/xal-plugins.git
cd xal-plugins/xal-opencode-free
./install.sh
```

Or install from the repository root:

```bash
cd xal-plugins
./install.sh        # then pick xal-opencode-free by number
```

The installer copies the plugin into `$XAL_DIR/plugins/xal-opencode-free`, adds `./plugins/xal-opencode-free` to the `plugins` array in `config.json`, and restarts are required to load it.

## API key

Get an OpenCode API key from `https://opencode.ai/auth`.

## Connect

```bash
xal
/connect → OpenCode Free → paste API key
```

or:

```bash
xal connect opencode-free
```

The key is validated against the Zen catalog. The key is stored through Xal's credential subsystem — never in plaintext in the plugin — and is redacted from any logged output.

## Use

```bash
xal
/models
```

Models are labeled with their source:

```
OpenCode Free

DeepSeek V4.1 Flash (Zen Free)
GLM 5.3 Flash (Zen Free)
MiMo V2.6 Flash (Zen Free)
Big Pickle (Zen Free)
...
```

Model IDs are source-prefixed (`zen/<id>`). Run `/model refresh` (or `xal models opencode-free`) to reload the catalog.

## Thinking effort (`/thinking`)

Models whose upstream accepts selectable reasoning effort expose a Xal `thinking` picker (`/thinking`); the chosen level is sent as `reasoning_effort`. The effort list comes per model from models.dev `reasoning_options` (bundled fallback for the default models) and is limited to what the upstream accepts — e.g. `glm-5.3-flash-free` / `deepseek-v4.1-flash-free` offer `low / high / max`, not Xal's full set. Models that are always thinking without configuration (e.g. `big-pickle`, `mimo-*`), toggle-only models, and models served on `/responses` (Muse Spark) have no picker. The default follows the upstream's own: `max` when offered, else `high`.

## How free classification works

0. Retired or unservable per synced metadata, or listed in `ZEN_EXCLUDED` (offline fallback, e.g. `jev-1.13-free`) → excluded
1. `ZEN_FORCE_PAID` override → excluded
2. Any explicit pricing > 0 → paid / excluded
3. Explicit all-zero pricing → free
4. Official free metadata/list → free
5. `ZEN_FORCE_FREE` override (minimal exceptions, e.g. `big-pickle`) → free
6. ID ends in `-free` → free (unless paid pricing wins)
7. Otherwise → **UNKNOWN, excluded**

Go models never reach this evaluation — the Go catalog is not queried (see [Go models are excluded](#️-go-models-are-excluded)).

`undefined` pricing is never treated as `0`. A zero-price model is free only when every relevant field is explicitly present and `0`.

## Thinking models: `reasoning_content` round-trip

DeepSeek/MiMo thinking-mode upstreams reject a request whose replayed assistant history lacks `reasoning_content`:

```
400 [invalid_request_error] The `reasoning_content` in the thinking mode must be passed back to the API.
```

The chat-completions transport therefore replays **every** assistant message with `reasoning_content` — the model's own reasoning when the host provides it, an explicit empty string otherwise (the upstream check is presence-based; an empty value is accepted). Tool-call turns and history written by a different model before a mid-session switch are covered too.

## Gateway client fingerprint (required)

OpenCode's free tier is restricted to the official OpenCode client. Without the client fingerprint every inference request returns:

```json
{
  "type": "FreeTierError",
  "message": "OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building."
}
```

The plugin therefore sends gateway requests with the official client's fingerprint while your own OpenCode API key still authenticates the request. Four gates are satisfied automatically (verified live against `opencode.ai`, 2026-10):

| gate                 | what the plugin sends                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| user-agent           | `opencode/<channel>/<version>/<artifact>` (default `opencode/stable/<installed CLI version>/cli-node`, configurable via `clientUserAgent`) |
| `x-opencode-session` | `ses_` + descending-timestamp hex + 14 base62, deterministically mapped from the Xal session id (stable per session, cache-friendly)       |
| tool declarations    | the required quartet `{bash, glob, grep, read}` is merged into every request alongside your client's own tools                             |
| streaming            | all requests are `stream: true` SSE                                                                                                        |

The injected quartet tools are described as compatibility placeholders; if a model calls one anyway, the host answers with an error tool result and the model falls back to the session's real tools.

> **Terms of service risk.** The fingerprint exists because the gateway refuses to serve the free tier to third-party clients, so presenting it may violate OpenCode's terms of service and put your account at risk (including suspension). It also stops working whenever OpenCode changes the check. `clientUserAgent` only changes the advertised identity; there is no off switch other than not using the plugin.

The default user-agent version follows the OpenCode CLI installed on this machine:

1. `XAL_OPENCODE_CLIENT_VERSION` (explicit override, any `x.y.z`)
2. `opencode --version` — the binary on `PATH`, then `~/.opencode/bin/opencode`, cached per process
3. the verified minimum (`VERIFIED_MINIMUM` in `client-version.ts`, currently `1.19.3`)

A detection below that minimum is raised to it. `426 Upgrade Required` in an error means the gateway floor moved above both: bump `VERIFIED_MINIMUM`.

If OpenCode changes the expected user-agent (e.g. a raised minimum version), override it without touching the plugin:

```json
{
  "pluginConfig": {
    "opencode-free": {
      "clientUserAgent": "opencode/stable/1.20.0/cli-node"
    }
  }
}
```

## Cache & refresh

The Zen catalog is cached under `<Xal cache>/opencode-free/`:

```
<runtime-cache>/opencode-free/
├── zen-models.json
├── models-dev-metadata.json  (synced context limits / retirements / protocols)
└── merged-free-models.json   (last known-good fallback)
```

- Default cache TTL is **10 minutes**.
- `/models` (refresh) force-refetches the catalog.
- A failed refresh falls back to the cached catalog.
- If the catalog cannot be fetched or served from cache at all, the last known-good merged list is used (stale `go/<id>` entries from older plugin versions are dropped).
- API keys are never written to these caches.

## Configuration

Defaults work with no configuration. Optional keys under `pluginConfig.opencode-free`:

```json
{
  "pluginConfig": {
    "opencode-free": {
      "cacheTtlMs": 600000,
      "debugModels": false,
      "modelContextWindows": {
        "nemotron-3-ultra-free": 262144
      },
      "defaultContextWindow": 131072,
      "syncModelMetadata": true,
      "modelMetadataTtlMs": 43200000,
      "clientUserAgent": "opencode/stable/1.19.3/cli-node"
    }
  }
}
```

- `cacheTtlMs` — catalog freshness window (ms). Default `600000`.
- `debugModels` — append dropped-model diagnostics to `/models` warnings.
- `modelContextWindows` — exact model ID (upstream ID, no `zen/` prefix) → maximum context window in tokens. Overrides any catalog-provided value and the bundled table. Use this for models whose context the catalog doesn't report.
- `defaultContextWindow` — fallback maximum for models unknown to the bundled table.
- `syncModelMetadata` — runtime sync with models.dev (see above). Default `true`; `false` uses only the bundled tables.
- `modelMetadataTtlMs` — how long synced metadata stays fresh (ms). Default `43200000` (12h).
- `modelMetadataUrl` — metadata source. Default `https://models.dev/api.json`.
- `clientUserAgent` — user-agent presented to the OpenCode gateway for the free-tier client check (see [Gateway client fingerprint](#gateway-client-fingerprint-required)). Default `opencode/stable/<installed CLI version>/cli-node`, falling back to `opencode/stable/1.19.3/cli-node`.

### Context windows

The catalog's `/models` response omits a context length, so the plugin resolves each free model's context window to keep Xal's compaction, `/compaction-limit`, and `/context-window` working. Source precedence:

1. `modelContextWindows` config override (exact upstream ID)
2. a context length parsed from the catalog entry, if any (`context_window` / `context_length` / `contextWindow`)
3. the synced models.dev `limit.context` (see [Automatic model metadata sync](#automatic-model-metadata-sync))
4. the bundled family table (offline fallback) — verified upstream values, not guesses:
   | model                                  | context window | source                                |
   | -------------------------------------- | -------------- | ------------------------------------- |
   | `deepseek-v4.1-flash-free`             | 200K           | OpenCode free-tier limit (models.dev) |
   | `glm-5.3-flash-free`                   | 200K           | OpenCode free-tier limit (models.dev) |
   | `mimo-*` (e.g. `mimo-v2.6-flash-free`) | 200K           | OpenCode free-tier limit (models.dev) |
   | `nemotron-3-ultra-free`                | 262K           | NVIDIA Nemotron 3 Ultra (HF)          |
   | `nemotron-3.5-lightning-free`          | 1M             | NVIDIA Nemotron 3.5 Lightning (HF)    |
   | `muse-spark-1.3-contributor-free`      | 1M             | live-probed against Zen               |
   | `big-pickle`                           | 200K           | OpenCode free-tier limit (models.dev) |
5. `defaultContextWindow` config fallback
6. a conservative 128K catch-all so every exposed free model gets a budget

The reported `contextWindow` is a budget capped at 256K by default, so auto-compaction engages at 80% of the budget. Models whose maximum exceeds the budget (e.g. 1M `nemotron-3.5-lightning-free`) additionally get a `contextWindows` ladder (`256K / 400K / 600K / 800K / maximum`) that enables `/context-window`.

**Muse Spark 1.3 Contributor is fixed-context**: it only serves OpenCode's **OpenAI `/responses`** protocol (it returns 500 from `chat/completions`), so the plugin routes it to `/responses`. It also rejects any context-window parameter (`max_input_tokens` → "does not support configurable context windows"), so the plugin exposes it with a single fixed `contextWindow` (1M) and **no** `contextWindows` ladder — Xal won't try to reconfigure it.

## Debug

```bash
xal
/opencode-free models
```

Prints the Zen free set and the dropped models with their classification reason.

## Requirements

- [Xal](https://github.com/xal-sh/xal) 0.1.0 or newer (needs the runtime credential subsystem)
- Bun (installer + tests)
