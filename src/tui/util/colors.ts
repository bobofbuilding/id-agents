// SPDX-License-Identifier: MIT
/**
 * Terminal (Ink) color mapping. The SEMANTIC classification lives in
 * renderer-neutral `dashboard-core/status.ts`; this file is the TUI's palette
 * that turns those semantic values into Ink color names. Outputs are identical
 * to the pre-extraction implementation (see the dashboard-core baseline test).
 */

import {
  type NewsAgeBucket,
  type StatusSeverity,
  healthGlyph,
  healthSeverity,
  newsAgeBucket,
  statusSeverity,
  taskGlyph,
  taskSeverity,
} from '../../dashboard-core/status.js';

const SEVERITY_INK: Record<StatusSeverity, string> = {
  ok: 'green',
  warn: 'yellow',
  error: 'red',
  neutral: 'gray',
};

const NEWS_INK: Record<NewsAgeBucket, string> = {
  fresh: 'greenBright',
  recent: 'green',
  stale: 'yellow',
  old: 'gray',
};

export function statusColor(status: string | undefined): string {
  return SEVERITY_INK[statusSeverity(status)];
}

export function healthColor(health: string | undefined): string {
  return SEVERITY_INK[healthSeverity(health)];
}

export function healthDot(health: string | undefined): string {
  return healthGlyph(health);
}

export function taskStatusColor(status: string): string {
  return SEVERITY_INK[taskSeverity(status)];
}

export function taskStatusGlyph(status: string): string {
  return taskGlyph(status);
}

export function newsAgeColor(timestampMs: number, cooldownEpochMs: number): string {
  return NEWS_INK[newsAgeBucket(timestampMs, cooldownEpochMs)];
}
