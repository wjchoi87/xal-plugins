# xal-ollama

Local [Ollama](https://ollama.com) server provider plugin for [Xal](https://github.com/xal-sh/xal). OpenAI-compatible endpoint, no API key required.

## Install

Clone the repo, then run this plugin's installer:

```bash
git clone <your-remote>
cd xal-ollama
./install.sh
```

The installer copies the plugin into `$XAL_DIR/plugins/xal-ollama` (`$XAL_DIR` is `$XAL_HOME`, or `~/.xal` by default), adds `./plugins/xal-ollama` to the `plugins` array in `config.json`, and preserves any existing entries.

## Configure

`pluginConfig.ollama.baseUrl` overrides the default endpoint:

```json
{
  "plugins": ["./plugins/xal-ollama"],
  "pluginConfig": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1"
    }
  }
}
```

Models that advertise a `thinking` capability are detected automatically from the server's `/api/tags` endpoint and expose `/thinking` controls with `reasoning_effort`; no per-model configuration is needed.

## Connect

```bash
xal connect ollama
```

No API key is needed. The plugin confirms the local server and stores an empty credential.

## Use

The model catalog is discovered from the server's `/v1/models` endpoint. Run `/model refresh` or `xal models ollama` to reload it. Start Xal and pick a model:

```bash
xal
/model
```

## Requirements

- [Xal](https://github.com/xal-sh/xal) 0.1.0 or newer
- [Ollama](https://ollama.com) running locally
