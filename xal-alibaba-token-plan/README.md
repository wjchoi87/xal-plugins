# xal-alibaba-token-plan

Alibaba token plan provider plugin for [Xal](https://github.com/xal-sh/xal). OpenAI-compatible endpoint with an API key; the base URL defaults to Alibaba's token plan endpoint.

## Install

Clone the repo, then run this plugin's installer:

```bash
git clone <your-remote>
cd xal-alibaba-token-plan
./install.sh
```

The installer copies the plugin into `$XAL_DIR/plugins/xal-alibaba-token-plan` (`$XAL_DIR` is `$XAL_HOME`, or `~/.xal` by default), adds `./plugins/xal-alibaba-token-plan` to the `plugins` array in `config.json`, and preserves any existing entries.

The installer defaults `pluginConfig["alibaba-token-plan"].baseUrl` to `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`; press Enter to accept the default or type a different endpoint.

## Configure

The installer writes `pluginConfig["alibaba-token-plan"].baseUrl` for you. It defaults to Alibaba's token plan endpoint; change it to your own endpoint if needed:

```json
{
  "plugins": ["./plugins/xal-plugins/xal-alibaba-token-plan"],
  "pluginConfig": {
    "alibaba-token-plan": {
      "baseUrl": "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1"
    }
  }
}
```

### Context windows

The endpoint's `/models` response only contains model IDs — it never reports a context length. The plugin therefore fills in context information from a bundled table verified against the Alibaba Cloud Model Studio docs (international / ap-southeast-1 catalog, snapshot 2026-08).

For every known model the plugin reports to Xal:

- `contextWindow` — the context budget Xal uses for compaction math. Defaults to the model's maximum capped at 256K (Model Studio's guidance says 128K–256K covers standard tasks), so auto-compaction engages at 80% of the budget by default (`/compaction-limit`).
- `contextWindows` — a selectable ladder (`256K / 400K / 600K / 800K / maximum` when the maximum exceeds the budget) that enables `/context-window`. Raising it increases the budget up to the model's physical maximum; the choice is persisted per model in `config.json`.

Two optional settings adjust the table:

```json
{
  "pluginConfig": {
    "alibaba-token-plan": {
      "baseUrl": "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
      "modelContextWindows": {
        "qwen3-32b": 131072
      },
      "defaultContextWindow": 131072
    }
  }
}
```

- `modelContextWindows`: exact model ID → maximum context window in tokens. Overrides the bundled table (and wins over any value the endpoint reports). Use this for region differences or custom/private models.
- `defaultContextWindow`: fallback maximum for model IDs unknown to the bundled table. Without it, unknown models stay without a context window.
- Known regional differences (China `cn-beijing` catalog vs the international default): `qwen-max` 32K, `qwen-turbo` 128K, `qwen3-235b-a22b`/`qwen3-32b`/`qwen3-14b`/`qwen3-8b` 128K, `glm-4.5`/`glm-4.5-air` 128K, `MiniMax-M2.7` 192K, `qwen2.5-omni-7b` 32K. Point `baseUrl` at a China endpoint and add these through `modelContextWindows`.

Models whose maximum does not exceed the default budget (for example `qwen-max` 128K or `qwen-mt-plus` 16K) get no ladder, so `/context-window` reports them as not configurable — the same behavior as Xal's OpenAI provider for models whose default equals the maximum.

Cached catalogs also get the context window filled in on read, so no `/model refresh` is strictly required after upgrading.

## Connect

```bash
xal connect alibaba-token-plan
```

Paste the plan API key when prompted. The plugin validates the key against `/models` before storing it.

## Use

Models are discovered from the endpoint's `/v1/models`. Run `/model refresh` or `xal models alibaba-token-plan` to reload the catalog, then pick a model in the TUI:

Models that emit `reasoning_content`/`reasoning` on a probe are detected automatically and expose `/thinking` controls; no per-model configuration is needed.

```bash
xal
/model
```

## Requirements

- [Xal](https://github.com/xal-sh/xal) 0.1.0 or newer
