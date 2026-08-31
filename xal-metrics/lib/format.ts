/*
 * Number formatting (#24): consistent across every surface.
 *
 * Tokens: 621, 4.3K, 18.2K, 63K, 1.2M — one decimal, trimmed when .0.
 * Duration: 820ms, 1.3s, 6.4s, 42s, 1m 30s.
 * TPS: 72.4, 621 — one decimal below 100, rounded above.
 */

function trimZero(value: number, fractionDigits: number): string {
  const fixed = value.toFixed(fractionDigits);
  return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
}

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) {
    const thousands = tokens / 1000;
    return thousands < 99.95
      ? `${trimZero(thousands, 1)}K`
      : `${Math.round(thousands)}K`;
  }
  const millions = tokens / 1_000_000;
  return millions < 999.5
    ? `${trimZero(millions, 1)}M`
    : `${Math.round(millions)}M`;
}

export function formatDuration(milliseconds: number): string {
  const value = Math.max(0, milliseconds);
  if (value < 1_000) return `${Math.round(value)}ms`;
  const seconds = value / 1000;
  if (seconds < 10) return `${trimZero(seconds, 1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
  }
  const remainder = Math.round(seconds % 60);
  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

export function formatTps(tps: number): string {
  return tps >= 100 ? String(Math.round(tps)) : trimZero(tps, 1);
}

export function formatPercent(rate: number): string {
  return String(Math.round(rate * 100));
}
