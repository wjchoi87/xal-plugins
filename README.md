# xal-plugins

Provider plugins for [Xal](https://github.com/xal-sh/xal). OpenAI-compatible endpoints as fully standalone plugins — clone once, install the ones you need.

## Plugins

| Plugin                                           | Provider             | Auth    | Base URL                              |
| ------------------------------------------------ | -------------------- | ------- | ------------------------------------- |
| [xal-ollama](xal-ollama)                         | Local Ollama server  | none    | `http://localhost:11434/v1` (default) |
| [xal-litellm](xal-litellm)                       | LiteLLM proxy server | API key | `http://localhost:4000/v1` (default)  |
| [xal-commandcode-bridge](xal-commandcode-bridge) | Command Code bridge  | API key | `http://localhost:8000/v1` (default)  |
| [xal-alibaba-token-plan](xal-alibaba-token-plan) | Alibaba token plan   | API key | required — set during install         |
| [xal-opencode-free](xal-opencode-free)           | OpenCode Free        | API key | `https://opencode.ai/zen/v1` (fixed)  |

Each plugin is self-contained and needs no runtime dependency on Xal's source or on the other plugins.

[xal-metrics](xal-metrics) is also packaged here: a non-provider plugin that collects per-turn timing and usage metrics (turn duration, tokens, cache hit rate, tool timing, and — when the XAL runtime supports the stream hook — TTFT, TPS and stalls). It installs the same way and is viewable with `/metrics`.

## Install

Clone once, then run the installer and pick the plugins you need by number (comma/space separated, or Enter for all):

```bash
git clone https://github.com/wjchoi87/xal-plugins.git
cd xal-plugins
./install.sh
```

```
Select plugins to install. Type comma/space separated numbers, or Enter for all.

  1. xal-ollama                 Local Ollama server
  2. xal-litellm                LiteLLM proxy server
  3. xal-commandcode-bridge     Command Code bridge
  4. xal-alibaba-token-plan     Alibaba token plan
  5. xal-opencode-free          OpenCode Free models
  6. xal-metrics                Per-turn timing and usage metrics

Selection [Enter = all]:
```

The installer copies each selected plugin into `$XAL_DIR/plugins/<name>` (`$XAL_DIR` is `$XAL_HOME`, or `~/.xal` by default), registers it in `config.json`, and asks for the base URL — re-running the installer pre-fills values you already configured.

To install a single plugin directly, run its own `install.sh`:

```bash
cd xal-ollama && ./install.sh
```

## Connect

```bash
xal connect ollama                 # no API key (local)
xal connect litellm                 # paste the proxy API key (Enter to skip)
xal connect commandcode-bridge      # paste the bridge API key
xal connect alibaba-token-plan      # paste the plan API key
xal connect opencode-free           # paste the OpenCode API key
```

## Requirements

- [Xal](https://github.com/xal-sh/xal) 0.1.0 or newer (plugins need the profile-aware `ctx.runtime` credential API)
- Bun and Python 3 (used by the installer scripts)
