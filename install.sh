#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PLUGINS=(
  "xal-ollama:Local Ollama server"
  "xal-commandcode-bridge:Command Code bridge"
  "xal-alibaba-token-plan:Alibaba token plan"
)
N=${#PLUGINS[@]}

stty_state=""
if [[ -t 0 ]]; then stty_state=$(stty -g 2>/dev/null || true); fi
restore_ui() {
  if [[ -n "$stty_state" ]]; then stty "$stty_state" 2>/dev/null || true; fi
  tput cnorm 2>/dev/null || true
}
trap restore_ui EXIT INT TERM

current=0
checks=()
for ((i = 0; i < N; i++)); do checks[$i]=1; done

render() {
  printf '\r'
  for ((i = 0; i < N; i++)); do
    name="${PLUGINS[$i]%%:*}"
    desc="${PLUGINS[$i]#*:}"
    marker=" "
    [[ ${checks[$i]} -eq 1 ]] && marker="x"
    lead="  "
    [[ $i -eq $current ]] && lead=">"
    printf '\033[2K  %s [%s] %-24s %s\n' "$lead" "$marker" "$name" "$desc"
  done
  printf '\033[%dA' "$N"
}

if [[ -t 0 ]]; then
  tput civis 2>/dev/null || true
  while :; do
    render
    if ! IFS= read -rsn 1 -t 600 key; then break; fi
    case "$key" in
      $'\x1b')
        rest=""
        IFS= read -rsn 3 -t 0.1 rest || true
        case "$rest" in
          $'\x1b[A') ((current = current > 0 ? current - 1 : N - 1)) ;;
          $'\x1b[B') ((current = current + 1 < N ? current + 1 : 0)) ;;
        esac
        ;;
      'k' | 'K')
        ((current = current > 0 ? current - 1 : N - 1))
        ;;
      'j' | 'J')
        ((current = current + 1 < N ? current + 1 : 0))
        ;;
      ' ') checks[$current]=$((1 - checks[$current])) ;;
      $'\r' | $'\n') break ;;
    esac
  done
  printf '\033[%dB' "$N"
fi
tput cnorm 2>/dev/null || true
echo ""

picks=()
for ((i = 0; i < N; i++)); do
  if [[ ${checks[$i]} -eq 1 ]]; then picks+=("${PLUGINS[$i]%%:*}"); fi
done

if [[ ${#picks[@]} -eq 0 ]]; then
  echo "No plugins selected; your Xal config is unchanged."
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
echo "(tip: ↑/↓ or j/k move · Space toggle · Enter confirm)"