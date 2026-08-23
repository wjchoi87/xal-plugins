# xal-commandcode-bridge

Command Code bridge provider plugin for [Xal](https://github.com/xal-sh/xal). OpenAI-compatible endpoint with an API key.

## Install

Clone the repo, then run this plugin's installer:

```bash
git clone <your-remote>
cd xal-commandcode-bridge
./install.sh
```

The installer copies the plugin into `$XAL_DIR/plugins/xal-commandcode-bridge` (`$XAL_DIR` is `$XAL_HOME`, or `~/.xal` by default), adds `./plugins/xal-commandcode-bridge` to the `plugins` array in `config.json`, and preserves any existing entries.

## Configure

The endpoint defaults to `http://localhost:8000/v1`. Override it with `pluginConfig.commandcode-bridge.baseUrl`:

```json
{
  "plugins": ["./plugins/xal-plugins/xal-commandcode-bridge"],
  "pluginConfig": {
    "commandcode-bridge": {
      "baseUrl": "https://bridge.example.com/v1"
    }
  }
}
```

## Connect

```bash
xal connect commandcode-bridge
```

Paste the bridge API key when prompted. The plugin validates the key against `/models` before storing it.

## Use

Models are discovered from the endpoint's `/v1/models`. Run `/model refresh` or `xal models commandcode-bridge` to reload the catalog, then pick a model in the TUI:

Models that emit `reasoning_content`/`reasoning` on a probe are detected automatically and expose `/thinking` controls; no per-model configuration is needed.

```bash
xal
/model
```

## Requirements

- [Xal](https://github.com/xal-sh/xal) 0.1.0 or newer
