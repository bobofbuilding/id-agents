// SPDX-License-Identifier: MIT
/** Renderer-neutral command-line parsing. */

/**
 * Split a raw input line (with or without a leading `:` / `/`) into command
 * name and args. Returns null when the line is empty after stripping the
 * prefix.
 */
export function parseCommandLine(raw: string): { name: string; args: string[] } | null {
  const stripped = raw.replace(/^[:/]+/, '').trim();
  if (!stripped) return null;
  const parts = stripped.split(/\s+/);
  return { name: parts[0]!, args: parts.slice(1) };
}
