#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PLUGINS=(
  "xal-ollama:Local Ollama server"
  "xal-litellm:LiteLLM proxy server"
  "xal-commandcode-bridge:Command Code bridge"
  "xal-alibaba-token-plan:Alibaba token plan"
  "xal-opencode-free:OpenCode Free models"
  "xal-zai-coding-plan:Z.ai GLM Coding Plan models"
  "xal-metrics:Per-turn timing and usage metrics"
  "xal-context-gc:Agent context memory paging"
)
N=${#PLUGINS[@]}

echo ""
echo "Select plugins to install. Type comma/space separated numbers, or Enter for all."
echo ""
for ((i = 0; i < N; i++)); do
  name="${PLUGINS[$i]%%:*}"
  desc="${PLUGINS[$i]#*:}"
  printf '  %d. %-26s %s\n' "$((i + 1))" "$name" "$desc"
done
echo ""
printf "Selection [Enter = all]: "
read -r -p "" answer || true

picks=()
if [[ -z "${answer// /}" ]]; then
  picks=("${PLUGINS[@]%%:*}")
else
  IFS=' ,' read -r -a parts <<< "$answer"
  for part in "${parts[@]}"; do
    num="${part//[^0-9]/}"
    [[ -z "$num" ]] && continue
    idx=$((num - 1))
    if ((idx >= 0 && idx < N)); then
      name="${PLUGINS[$idx]%%:*}"
      existing=false
      for pick in ${picks[@]+"${picks[@]}"}; do
        [[ "$pick" == "$name" ]] && existing=true
      done
      if [[ "$existing" == false ]]; then
        picks+=("$name")
      fi
    fi
  done
fi

echo ""
if [[ ${#picks[@]} -eq 0 ]]; then
  echo "No valid selections; your Xal config is unchanged."
  exit 0
fi
echo "Installing: ${picks[*]}"
echo ""

for p in "${picks[@]}"; do
  echo "== $p =="
  "$ROOT/$p/install.sh"
  echo ""
done

echo "Done. Restart Xal to load the installed plugins."