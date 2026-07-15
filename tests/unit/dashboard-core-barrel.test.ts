// SPDX-License-Identifier: MIT
/**
 * The public barrel `src/dashboard-core/index.ts` must re-export every
 * commit-2/3 surface (API, formatters, status, schedule, selectors) so a single
 * `dashboard-core` import resolves the shared domain layer. This test imports a
 * representative symbol from each surface through the barrel.
 */

import { describe, expect, it } from 'vitest';
import {
  // api (commit 2)
  ManagerClient,
  ManagerError,
  parseTeamsResponse,
  // formatters (commit 3)
  humanizeUptime,
  abbrevModel,
  detectTabularResult,
  // status (commit 3)
  abbrevStatus,
  statusSeverity,
  newsAgeBucket,
  // schedule (commit 3)
  formatInterval,
  nextFireSec,
  // selectors (commit 3)
  orderTeams,
  countByTeam,
  clampIndex,
  clampScroll,
} from '../../src/dashboard-core/index.js';

describe('dashboard-core barrel', () => {
  it('re-exports the API surface', () => {
    expect(typeof ManagerClient).toBe('function');
    expect(typeof ManagerError).toBe('function');
    expect(typeof parseTeamsResponse).toBe('function');
  });

  it('re-exports formatters', () => {
    expect(humanizeUptime(0, 30_000)).toBe('new');
    expect(abbrevModel('claude-opus-4-8')).toBe('opus-4.8');
    expect(detectTabularResult([{ a: 1 }, { a: 2 }])?.fieldName).toBe('rows');
  });

  it('re-exports status semantics', () => {
    expect(abbrevStatus('running')).toBe('run');
    expect(statusSeverity('offline')).toBe('error');
    expect(newsAgeBucket(0, 0)).toBe('fresh');
  });

  it('re-exports schedule math', () => {
    expect(formatInterval(3600)).toBe('1h');
    expect(typeof nextFireSec).toBe('function');
  });

  it('re-exports selectors', () => {
    expect(orderTeams([{ name: 'a' }, { name: 'public' }]).map((t) => t.name)).toEqual(['public', 'a']);
    expect(countByTeam([{ teamName: 'x' }, { teamName: 'x' }]).get('x')).toBe(2);
    expect(clampIndex(20, 10)).toBe(9);
    expect(clampScroll(3, 2, 0, 5)).toEqual({ index: 0, windowStart: 0 });
  });
});
