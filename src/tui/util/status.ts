// Short names for agent status / health strings shown in the TUI agents table.
//
// Maintain these tables by hand, exactly like util/models.ts. When a new status
// appears, add an entry. Until then the value displays verbatim (and may
// overflow), which makes the missing entry obvious.

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
