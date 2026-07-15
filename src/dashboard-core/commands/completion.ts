// SPDX-License-Identifier: MIT
/**
 * Renderer-neutral tab completion over the shared command catalog. Operates on
 * the raw buffer string and an `ArgCompleterContext`; returns the new buffer or
 * null when no completion applies.
 */

import { lookupPolicy, policyNames } from './catalog.js';
import type { ArgCompleterContext } from './types.js';

/**
 * Top-level (first-token) completion. Operates only on the token before any
 * whitespace. Returns the new buffer string, or null if none can be applied.
 */
export function completeCommand(buffer: string): string | null {
  if (buffer.length < 1) return null;
  const sigil = buffer[0];
  if (sigil !== ':' && sigil !== '/') return null;
  const rest = buffer.slice(1);
  if (rest.includes(' ')) return null;
  const matches = policyNames().filter((n) => n.startsWith(rest));
  if (matches.length === 0) return null;
  if (matches.length === 1) {
    if (matches[0] === rest) return null;
    return sigil + matches[0] + ' ';
  }
  let prefix = matches[0]!;
  for (const m of matches.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < m.length && prefix[i] === m[i]) i++;
    prefix = prefix.slice(0, i);
  }
  if (prefix.length <= rest.length) return null;
  return sigil + prefix;
}

// Longest-common-prefix helper shared by the completion paths. Returns '' for
// empty input, otherwise the prefix common to all entries.
function longestCommonPrefix(strs: string[]): string {
  if (strs.length === 0) return '';
  let prefix = strs[0]!;
  for (const s of strs.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < s.length && prefix[i] === s[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix;
}

/**
 * Full completion that handles both the first-token slot and arg slots. The
 * buffer-aware path tokenises the input, decides whether the cursor is on the
 * command name or an arg, and delegates to the resolved policy's argCompleter
 * for slot candidates. Returns the new buffer or null.
 */
export function completeBuffer(buffer: string, ctx: ArgCompleterContext): string | null {
  if (buffer.length < 1) return null;
  const sigil = buffer[0];
  if (sigil !== ':' && sigil !== '/') return null;
  const rest = buffer.slice(1);

  // No spaces yet → first-token completion.
  if (!/\s/.test(rest)) {
    return completeCommand(buffer);
  }

  // Tokenise. The "partial" is the trailing token unless the buffer ends in
  // whitespace, in which case the partial is empty (the user is asking what's
  // next).
  const endsWithSpace = /\s$/.test(rest);
  const tokens = rest.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  const name = tokens[0]!;
  const completedArgs = endsWithSpace ? tokens.slice(1) : tokens.slice(1, -1);
  const partial = endsWithSpace ? '' : tokens[tokens.length - 1] ?? '';

  const policy = lookupPolicy(name);
  if (!policy || !policy.argCompleter) return null;

  const slot = completedArgs.length;
  const candidates = policy.argCompleter(slot, ctx);
  if (candidates.length === 0) return null;
  const matches = candidates.filter((c) => c.startsWith(partial));
  if (matches.length === 0) return null;

  // Replace the trailing partial with either the unique match (+ trailing
  // space) or the longest common prefix (no space).
  const trim = buffer.length - partial.length;
  if (matches.length === 1) {
    if (matches[0] === partial) return null;
    return buffer.slice(0, trim) + matches[0] + ' ';
  }
  const lcp = longestCommonPrefix(matches);
  if (lcp.length <= partial.length) return null;
  return buffer.slice(0, trim) + lcp;
}
