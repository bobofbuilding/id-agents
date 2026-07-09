// Short names for Codex reasoning effort strings shown in the TUI agents table.
//
// Maintain this table by hand, mirroring util/models.ts and util/status.ts.
// Unknown values pass through verbatim so missing entries are visible.

export const EFFORT_ABBREVIATIONS: Record<string, string> = {
  high: 'hi',
  medium: 'med',
  low: 'lo',
  xhigh: 'xhi',
};

export function abbrevEffort(effort: string | undefined): string {
  if (!effort) return '—';
  return EFFORT_ABBREVIATIONS[effort] ?? effort;
}
