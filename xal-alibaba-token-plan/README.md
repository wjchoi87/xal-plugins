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
