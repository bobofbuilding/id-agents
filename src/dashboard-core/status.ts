// SPDX-License-Identifier: MIT
/**
 * Renderer-neutral status semantics shared by the TUI and the Electron
 * dashboard.
 *
 * This module owns the SEMANTIC decisions — short display abbreviations, a
 * four-level severity classification, a news-age bucket, and monochrome status
 * glyphs. It deliberately does NOT know about Ink color names ('green', …) or
 * any renderer palette: each surface maps these semantic values to its own
 * colors. `src/tui/util/colors.ts` is that mapping for the terminal.
 */

/* ---------------- abbreviations (STATUS / HEALTH columns) ---------------- */

// Process status shown in the STATUS column (local agent.status and the
// health-derived label used for remote agents).
export const STATUS_ABBREVIATIONS: Record<string, string> = {
  running: 'run',
  stopped: 'stp',
  stopping: 'stg',
  pending: 'pnd',
  starting: 'srt',
  error: 'err',
  offline: 'off',
  online: 'onl',
  unstable: 'uns',
  registered: 'reg',
  unknown: 'unk',
};

// Health label shown in the HEALTH column next to the dot (online is rendered
// as the dot alone, so it is intentionally absent here).
export const HEALTH_ABBREVIATIONS: Record<string, string> = {
  unstable: 'uns',
  offline: 'off',
  registered: 'reg',
  unknown: 'unk',
};

/**
 * Short display name for an agent status.
 *   - In the table → returns the 3-letter abbreviation.
 *   - Not in the table → returns the input unchanged (mirrors abbrevModel).
 *   - Missing/empty → returns `—`.
 */
export function abbrevStatus(status: string | undefined): string {
  if (!status) return '—';
  return STATUS_ABBREVIATIONS[status] ?? status;
}

/**
 * Short display label for a non-online health value. Falls through to the raw
 * value when unmapped, like abbrevModel/abbrevStatus.
 */
export function abbrevHealth(health: string | undefined): string {
  if (!health) return '—';
  return HEALTH_ABBREVIATIONS[health] ?? health;
}

/* ---------------- severity classification ---------------- */

/** Four-level semantic severity a renderer maps to its own palette. */
export type StatusSeverity = 'ok' | 'warn' | 'error' | 'neutral';

export function statusSeverity(status: string | undefined): StatusSeverity {
  switch (status) {
    case 'running':
      return 'ok';
    case 'offline':
      return 'error';
    case 'starting':
    case 'stopping':
      return 'warn';
    default:
      return 'neutral';
  }
}

export function healthSeverity(health: string | undefined): StatusSeverity {
  if (health === 'online') return 'ok';
  if (health === 'unstable') return 'warn';
  if (health === 'offline') return 'error';
  return 'neutral';
}

export function taskSeverity(status: string | undefined): StatusSeverity {
  switch (status) {
    case 'todo':
      return 'warn';
    case 'doing':
      return 'ok';
    case 'done':
      return 'neutral';
    default:
      return 'neutral';
  }
}

/* ---------------- news-age bucket ---------------- */

/** Discrete freshness band for a news item, from a timestamp + shared epoch. */
export type NewsAgeBucket = 'fresh' | 'recent' | 'stale' | 'old';

/**
 * Bucket a news item's age. Derived purely from the item's timestamp and a
 * shared cooldown epoch (updated on a tick by the renderer), never from a
 * free-running clock, so output is byte-stable within each band.
 */
export function newsAgeBucket(timestampMs: number, cooldownEpochMs: number): NewsAgeBucket {
  const ageSec = Math.max(0, Math.floor((cooldownEpochMs - timestampMs) / 1000));
  if (ageSec < 60) return 'fresh';
  if (ageSec < 300) return 'recent';
  if (ageSec < 900) return 'stale';
  return 'old';
}

/* ---------------- monochrome glyphs ---------------- */

/** Filled/hollow dot for an agent health value (color applied by the renderer). */
export function healthGlyph(health: string | undefined): string {
  if (health === 'online') return '●';
  if (health === 'unstable') return '●';
  if (health === 'offline') return '○';
  return '○'; // registered / unknown — never probed
}

/** Glyph for a task status. */
export function taskGlyph(status: string | undefined): string {
  if (status === 'done') return '●';
  if (status === 'doing') return '●';
  if (status === 'todo') return '○';
  return '·';
}
