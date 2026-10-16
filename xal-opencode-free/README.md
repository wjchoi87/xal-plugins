# xal-opencode-free

OpenCode Free provider plugin for [Xal](https://github.com/xal-sh/xal). It exposes **only** the models OpenCode currently serves for free on its two sources:

- **OpenCode Zen Free**
- **OpenCode Go Free**

Paid Zen models and general Go subscription models never appear. The free set is driven by the live OpenCode catalogs, so new free models show up on `/models` refresh without a plugin update.

## Automatic model metadata sync

OpenCode's `/models` catalogs list only model IDs. Everything else the plugin needs — each model's context limit, whether it has been retired, and which protocol it is served on — is synced at runtime from [models.dev](https://models.dev) (`opencode` = Zen, `opencode-go` = Go), the same metadata OpenCode's own client uses. No plugin update or reinstall is needed when OpenCode changes a model:

| upstream change                                                  | what the plugin does                                                    |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| new free model / changed context limit                           | uses the published `limit.context` for compaction and `/context-window` |
| model marked `status = "deprecated"`                             | hides it from `/models` (reason `upstream-deprecated`)                  |
| model served on `/responses`/`/messages`                         | routes requests to that endpoint automatically                          |
| model on a protocol the plugin can't stream (System One, Gemini) | hides it (reason `unsupported-protocol`)                                |

- Synced with the catalog, cached for **12 hours** (`modelMetadataTtlMs`); `/models` refresh forces a re-sync.
- Only the OpenCode entries are kept (a few KB, `<runtime-cache>/opencode-free/models-dev-metadata.json`). Your OpenCode API key is never sent to models.dev.
- If models.dev is unreachable the last synced snapshot is used, then the bundled tables below.

## What "FREE" means here

FREE means a model that OpenCode currently serves on that source without a separate token charge or _without consuming your Go subscription allowance_ (i.e. an explicitly free / free-preview model).

It does **not** mean:

- unlimited usage
- no rate limits
- always online
- any SLA
- a free preview that will never end

FREE is determined **fail-closed**: if we cannot be confident a model is free, it is excluded. `UNKNOWN != FREE`.

## ⚠️ Go is a paid subscription service

OpenCode Go itself is a paid subscription. General Go models consume your subscription allowance and are **never** exposed here. Only Go models that are explicitly offered as `*-free` / free-preview (or manually verified free) are shown. This is why most Go catalog entries are dropped.

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

Get an OpenCode API key from `https://opencode.ai/auth` (the same key works for both Zen and Go).

## Connect

```bash
xal
/connect → OpenCode Free → paste API key
```

or:

```bash
xal connect opencode-free
```

The key is validated against **both** sources independently. One source being unavailable (e.g. no Go entitlement) does not block a working other source. The key is stored through Xal's credential subsystem — never in plaintext in the plugin — and is redacted from any logged output.

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

Model IDs are source-prefixed (`zen/<id>`, `go/<id>`) so the same upstream model on two sources is kept distinct. Run `/model refresh` (or `xal models opencode-free`) to reload the catalog.

## How free classification works

### Zen Free

0. Retired or unservable per synced metadata, or listed in `ZEN_EXCLUDED` (offline fallback, e.g. `jev-1.13-free`) → excluded
1. `ZEN_FORCE_PAID` override → excluded
2. Any explicit pricing > 0 → paid / excluded
3. Explicit all-zero pricing → free
4. Official free metadata/list → free
5. `ZEN_FORCE_FREE` override (minimal exceptions, e.g. `big-pickle`) → free
6. ID ends in `-free` → free (unless paid pricing wins)
7. Otherwise → **UNKNOWN, excluded**

### Go Free

Go defaults to **subscription / not free**. A Go model is only free with positive evidence:

0. Retired or unservable per synced metadata, or listed in `GO_EXCLUDED` (offline fallback) → excluded
1. `GO_FORCE_PAID` override → excluded
2. Explicit paid/subscription metadata → excluded
3. Official Go free metadata/list → free
4. ID is `*-free` / `*-free-*` → free (unless paid metadata wins)
5. `GO_FORCE_FREE` override → free
6. Everything else → subscription model, **excluded**

`undefined` pricing is never treated as `0`. A zero-price model is free only when every relevant field is explicitly present and `0`.

## Cache & refresh

Each source (Zen, Go) has its own cache under `<Xal cache>/opencode-free/`:

```
<runtime-cache>/opencode-free/
├── zen-models.json
├── go-models.json
├── models-dev-metadata.json  (synced context limits / retirements / protocols)
└── merged-free-models.json   (last known-good fallback)
```

- Default cache TTL is **10 minutes**.
- `/models` (refresh) force-refetches both sources.
- If one source fails, the other's fresh result is still used; a failed source falls back to its own cache.
- If both sources fail entirely, the last known-good merged list is used.
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
        "cat-jam-free": 1048576
      },
      "defaultContextWindow": 131072,
      "syncModelMetadata": true,
      "modelMetadataTtlMs": 43200000
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

Prints the Zen/Go free sets and each source's dropped models with their classification reason.

## Requirements

- [Xal](https://github.com/xal-sh/xal) 0.1.0 or newer (needs the runtime credential subsystem)
- Bun (installer + tests)
