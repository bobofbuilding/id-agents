// SPDX-License-Identifier: MIT
/**
 * The public barrel `src/dashboard-core/index.ts` must re-export every
 * surface (API, formatters, status, schedule, selectors, commands) so a single
 * `dashboard-core` import resolves the shared domain layer. This test imports a
 * representative symbol from each surface through the barrel, and pins the
 * command-policy + news-party symbols the external desktop consumer relies on.
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
  // shared news-party selector (boundary commit 3)
  newsParty,
  newsPartyLabel,
  // command policy (boundary commit 3)
  COMMAND_POLICIES,
  lookupPolicy,
  policyNames,
  catalogEntriesByTier,
  completeCommand,
  completeBuffer,
  confirmationLevel,
  commandConfirmPreview,
  parseCommandLine,
  type CommandPolicy,
  type ConfirmationLevel,
  type RiskTier,
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

  it('re-exports the shared news-party selector', () => {
    expect(newsParty({ type: 'outbound.query', data: { to: 'coder' } })).toEqual({
      dir: 'to',
      name: 'coder',
    });
    expect(newsPartyLabel(newsParty({ type: 'reply', data: { from: 'pm' } }))).toBe('from: pm');
  });

  it('re-exports the full command-policy surface', () => {
    // Values: every command-policy API the external consumer imports.
    expect(typeof COMMAND_POLICIES).toBe('object');
    expect(typeof policyNames).toBe('function');
    expect(typeof catalogEntriesByTier).toBe('function');
    expect(typeof completeCommand).toBe('function');
    expect(typeof completeBuffer).toBe('function');
    expect(typeof commandConfirmPreview).toBe('function');
    expect(typeof parseCommandLine).toBe('function');

    // Behavioral reachability: the catalog answers through the barrel and
    // the confirmation gate consumes a barrel-typed policy. The type-only
    // imports above (CommandPolicy/ConfirmationLevel/RiskTier) make type
    // re-export regressions fail compilation.
    const policy: CommandPolicy | null = lookupPolicy('agents');
    expect(policy).not.toBeNull();
    const level: ConfirmationLevel = confirmationLevel(policy!, []);
    expect(['none', 'yn', 'retype']).toContain(level);
    const tiers: Record<RiskTier, CommandPolicy[]> = catalogEntriesByTier();
    expect(Object.keys(tiers).length).toBeGreaterThan(0);
  });
});
