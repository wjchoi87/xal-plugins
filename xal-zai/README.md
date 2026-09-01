# xal-zai

[Z.ai](https://z.ai) GLM provider plugin for [Xal](https://github.com/xal-sh/xal). OpenAI-compatible endpoint with an API key; the base URL defaults to Z.ai's public OpenAI-compatible endpoint.

## Install

Clone the repo, then run this plugin's installer:

```bash
git clone <your-remote>
cd xal-zai
./install.sh
```

The installer copies the plugin into `$XAL_DIR/plugins/xal-zai` (`$XAL_DIR` is `$XAL_HOME`, or `~/.xal` by default), adds `./plugins/xal-zai` to the `plugins` array in `config.json`, and preserves any existing entries.

The installer defaults `pluginConfig["zai"].baseUrl` to `https://api.z.ai/api/paas/v4`; press Enter to accept the default or type a different endpoint (for example a GLM Coding Plan dedicated endpoint).

## Configure

The installer writes `pluginConfig["zai"].baseUrl` for you. It defaults to Z.ai's public OpenAI-compatible endpoint; change it to your own endpoint if needed:

```json
{
  "plugins": ["./plugins/xal-zai"],
  "pluginConfig": {
    "zai": {
      "baseUrl": "https://api.z.ai/api/paas/v4"
    }
  }
}
```

### Context windows

The endpoint's `/models` response only contains model IDs — it never reports a context length. The plugin therefore fills in context information from a bundled table verified against the [Z.AI docs](https://docs.z.ai/guides/overview/overview) (snapshot 2026-09).

For every known model the plugin reports to Xal:

- `contextWindow` — the context budget Xal uses for compaction math. Defaults to the model's maximum capped at 256K, so auto-compaction engages at 80% of the budget by default (`/compaction-limit`).
- `contextWindows` — a selectable ladder (`256K / 400K / 600K / 800K / maximum` when the maximum exceeds the budget) that enables `/context-window`. Raising it increases the budget up to the model's physical maximum; the choice is persisted per model in `config.json`.

A couple of examples from the bundled table (model → max context): `glm-5.3`/`glm-5.3-flash`/`glm-5.2` → 1M, `glm-5.1`/`glm-5`/`glm-4.7`/`glm-4.6` → 200K, `glm-4.5`/`glm-4.5-air` → 128K, `glm-4.6v` → 128K, `glm-4.5v` → 64K.

Two optional settings adjust the table:

```json
{
  "pluginConfig": {
    "zai": {
      "baseUrl": "https://api.z.ai/api/paas/v4",
      "modelContextWindows": {
        "glm-4.5": 131072
      },
      "defaultContextWindow": 131072
    }
  }
}
```

- `modelContextWindows`: exact model ID → maximum context window in tokens. Overrides the bundled table (and wins over any value the endpoint reports). Use this for endpoint differences or custom/private models.
- `defaultContextWindow`: fallback maximum for model IDs unknown to the bundled table. Without it, unknown models stay without a context window.

Models whose maximum does not exceed the default budget (for example `glm-4.5v` 64K) get no ladder, so `/context-window` reports them as not configurable — the same behavior as Xal's OpenAI provider for models whose default equals the maximum.

## Connect

```bash
xal connect zai
```

Paste the Z.ai API key when prompted (create one at [z.ai/manage-apikey](https://z.ai/manage-apikey/apikey-list)). The plugin validates the key against `/models` before storing it, and redacts it from logs.

## Use

Models are discovered from the endpoint's `/v1/models`. Run `/model refresh` or `xal models zai` to reload the catalog, then pick a model in the TUI:

```bash
xal
/model
```

GLM text and vision models expose `/thinking` controls; the lightweight free `-flash` models and image/video generators do not. Vision models (`glm-4.6v`, `glm-5.3-flash`, …) accept image input.

## Requirements

- [Xal](https://github.com/xal-sh/xal) 0.1.0 or newer
