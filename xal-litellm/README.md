# xal-litellm

[LiteLLM](https://litellm.ai) proxy server provider plugin for [Xal](https://github.com/xal-sh/xal). OpenAI-compatible endpoint; API key is optional (send one in `Authorization: Bearer <key>` if the proxy requires it).

## Install

Clone the repo, then run this plugin's installer:

```bash
git clone <your-remote>
cd xal-litellm
./install.sh
```

The installer copies the plugin into `$XAL_DIR/plugins/xal-litellm` (`$XAL_DIR` is `$XAL_HOME`, or `~/.xal` by default), adds `./plugins/xal-litellm` to the `plugins` array in `config.json`, and preserves any existing entries.

## Configure

`pluginConfig.litellm.baseUrl` overrides the default endpoint:

```json
{
  "plugins": ["./plugins/xal-litellm"],
  "pluginConfig": {
    "litellm": {
      "baseUrl": "http://localhost:4000/v1"
    }
  }
}
```

## Connect

```bash
xal connect litellm
```

The plugin prompts for an API key. Press Enter to skip for an unauthenticated/no-key proxy — the plugin stores an empty credential. To protect the endpoint with an API key, enter it when prompted; it is sent as `Authorization: Bearer <key>` on requests.

## Use

The model catalog is discovered from the server's OpenAI-compatible `/models` endpoint. Run `/model refresh` or `xal models litellm` to reload it. Start Xal and pick a model:

```bash
xal
/model
```

Models whose ID advertises a `thinking`, `reasoning`, or `rNN` capability are detected automatically and expose `/thinking` controls with `reasoning_effort`; no per-model configuration is needed.

## Requirements

- [Xal](https://github.com/xal-sh/xal) 0.1.0 or newer
- A running [LiteLLM](https://litellm.ai) proxy server
