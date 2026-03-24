/**
 * ============================================================================
 * MODULE: formatters.js
 * PURPOSE: Shared display formatting utilities for net worth, distance, time.
 *          DB values are NOT changed — only the display output is affected.
 * ============================================================================
 */

/**
 * Format large numbers compactly: 500 → "500", 1500 → "1.5k", 2500000 → "2.5M"
 */
function formatCompact(value) {
  const n = Number(value) || 0;
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return m % 1 === 0 ? `${m}M` : `${m.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    const k = n / 1_000;
    return k % 1 === 0 ? `${k}k` : `${k.toFixed(1)}k`;
  }
  return n.toLocaleString();
}

/**
 * Format distance compactly: 500 → "500 KMs", 40000 → "40k KMs"
 */
function formatDistance(km) {
  const n = Math.round(Number(km) || 0);
  return `${formatCompact(n)} KMs`;
}

/**
 * Format minutes as hours only: 3000 → "50 Hours", 60000 → "1k Hours"
 */
function formatHours(minutes) {
  const hours = Math.round((Number(minutes) || 0) / 60);
  return `${formatCompact(hours)} Hours`;
}

module.exports = { formatCompact, formatDistance, formatHours };
