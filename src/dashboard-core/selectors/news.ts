// SPDX-License-Identifier: MIT
/** Pure news selection seams. */

import type { NewsItem } from '../api/types.js';

/** Newest-first copy of the news items (does not mutate the input). */
export function sortNewsByTimestamp(items: NewsItem[]): NewsItem[] {
  return [...items].sort((a, b) => b.timestamp - a.timestamp);
}

/** Which side of the exchange the party label describes. */
export type NewsPartyDir = 'to' | 'from' | '';

export interface NewsParty {
  dir: NewsPartyDir;
  name: string;
}

/**
 * Derive the explicit From / To counterparty for a news item — the shared
 * source of truth behind both the TUI news view and the desktop news rows so
 * they stay in parity. The current agent fills the implicit side: outbound items
 * are TO a recipient, inbound items are FROM a sender; self-status events have no
 * party. Protocol-level `remote` is rewritten to `manager` for UI clarity (the
 * underlying data is unchanged). Only `type` + `data.{from,to}` are consulted.
 */
export function newsParty(item: { type: string; data?: unknown }): NewsParty {
  const d = (item.data ?? {}) as Record<string, unknown>;
  const normalize = (v: unknown): string => {
    const raw = typeof v === 'string' ? v : '';
    return raw === 'remote' ? 'manager' : raw;
  };
  const from = normalize(d.from);
  const to = normalize(d.to);
  const type = item.type;

  if (type.startsWith('outbound')) {
    return to ? { dir: 'to', name: to } : { dir: '', name: '' };
  }
  if (type === 'query.received') {
    return { dir: 'from', name: from || 'manager' };
  }
  if (
    type === 'reply' ||
    type === 'notify' ||
    type === 'message' ||
    type === 'news.received' ||
    type === 'inbound.reply'
  ) {
    return from ? { dir: 'from', name: from } : { dir: '', name: '' };
  }
  return { dir: '', name: '' };
}

/**
 * Single-column party label, matching the TUI exactly: `  to: <x>` for outbound
 * (two leading spaces so it aligns under `from:`), `from: <x>` for inbound, and
 * `''` for self-status events.
 */
export function newsPartyLabel(party: NewsParty): string {
  if (party.dir === 'to') return `  to: ${party.name}`;
  if (party.dir === 'from') return `from: ${party.name}`;
  return '';
}
