# xal-opencode-free

OpenCode Free provider plugin for [Xal](https://github.com/xal-sh/xal). It exposes **only** the models OpenCode currently serves for free on its two sources:

- **OpenCode Zen Free**
- **OpenCode Go Free**

Paid Zen models and general Go subscription models never appear. The free set is driven by the live OpenCode catalogs, so new free models show up on `/models` refresh without a plugin update.

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

DeepSeek V4 Flash (Zen Free)
MiMo V2.5 (Zen Free)
Big Pickle (Zen Free)
...
```

Model IDs are source-prefixed (`zen/<id>`, `go/<id>`) so the same upstream model on two sources is kept distinct. Run `/model refresh` (or `xal models opencode-free`) to reload the catalog.

## How free classification works

### Zen Free

1. `ZEN_FORCE_PAID` override → excluded
2. Any explicit pricing > 0 → paid / excluded
3. Explicit all-zero pricing → free
4. Official free metadata/list → free
5. `ZEN_FORCE_FREE` override (minimal exceptions, e.g. `big-pickle`) → free
6. ID ends in `-free` → free (unless paid pricing wins)
7. Otherwise → **UNKNOWN, excluded**

### Go Free

Go defaults to **subscription / not free**. A Go model is only free with positive evidence:

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
      "debugModels": false
    }
  }
}
```

- `cacheTtlMs` — catalog freshness window (ms). Default `600000`.
- `debugModels` — append dropped-model diagnostics to `/models` warnings.

## Debug

```bash
xal
/opencode-free models
```

Prints the Zen/Go free sets and each source's dropped models with their classification reason.

## Requirements

- [Xal](https://github.com/xal-sh/xal) 0.1.0 or newer (needs the runtime credential subsystem)
- Bun (installer + tests)
