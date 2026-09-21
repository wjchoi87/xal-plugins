# xal-custom-provider

A generic provider plugin for [Xal](https://github.com/xal-sh/xal). It registers
one `custom` provider whose **each connection profile** carries its own base
URL, wire protocol, and API key. Create as many profiles as you need with
`xal connect custom <name>` — a vLLM box, OpenRouter, an Anthropic gateway —
and switch between them without reinstalling or editing config.

## Protocols

When you connect a profile, you pick which wire protocol its endpoint speaks:

| #   | Protocol             | Endpoint                       | Auth headers                             | Typical servers                                        |
| --- | -------------------- | ------------------------------ | ---------------------------------------- | ------------------------------------------------------ |
| 1   | `chat-completions`   | `POST {base}/chat/completions` | `authorization: Bearer <key>`            | vLLM, LiteLLM, Ollama, OpenRouter, most OpenAI proxies |
| 2   | `responses`          | `POST {base}/responses`        | `authorization: Bearer <key>`            | servers exposing the OpenAI Responses API              |
| 3   | `anthropic-messages` | `POST {base}/messages`         | `x-api-key: <key>` + `anthropic-version` | Anthropic API and Anthropic-compatible gateways        |

`baseUrl` is the version root for all three, so `/models` discovery works
uniformly (OpenAI-compatible servers and the Anthropic API both serve
`GET {base}/models` returning `{"data": [...]}`).

## Install

The installer only copies the plugin and registers it — no prompts, no URL:

```bash
# from the repo root, or run this plugin's own install.sh
./install.sh
```

Restart Xal, then create one profile per endpoint. Each connect asks for the
protocol, the base URL, and the API key (Enter to skip for an unauthenticated
local server), and validates them against `{base}/models` before saving:

```bash
xal connect custom vllm      # 1, http://localhost:8000/v1, (no key)
xal connect custom openrouter # 1, https://openrouter.ai/api/v1, <key>
xal connect custom claude    # 3, https://api.anthropic.com/v1, <key>
```

Each profile stores its `{baseUrl, protocol, key}` inside its own Xal
credential, so they are fully independent. `xal profiles` lists them, and the
TUI selects which profile a session runs on — exactly as for any other
provider. To change a profile's endpoint or protocol, connect a new one (or
`xal logout <name>` and reconnect).

## Legacy / global config (optional)

For compatibility, a single default endpoint can still be set in
`pluginConfig.custom` of `$XAL_DIR/config.json`:

| Key        | Meaning                                                  |
| ---------- | -------------------------------------------------------- |
| `baseUrl`  | version root of the endpoint                             |
| `protocol` | `chat-completions`, `responses`, or `anthropic-messages` |

A connected profile's stored values take precedence; a profile is only
affected by these globals when its credential was created without a base URL
or protocol (e.g. connected against an older version of this plugin).

## Notes

- Model discovery, thinking-effort detection (ids containing
  `thinking`/`reasoning`/`rNN`), image input, and tool calling follow the same
  conventions as the other provider plugins in this repo.
- The Anthropic transport maps Xal tool calls to `tool_use`/`tool_result`
  blocks and streams `thinking` deltas as reasoning summaries.
- Per-profile endpoints ride in Xal's credential store, which persists the
  credential object verbatim (requires the profile-aware runtime, Xal
  0.1.0-beta.239 or newer).
