// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { adminAuthorizationHeaders, adminBearerMatches, captureAdminToken } from '../../src/admin-auth.js';

describe('IDACC admin bearer authentication', () => {
  it('preserves the legacy loopback/header contract when no token is configured', () => {
    expect(adminBearerMatches(undefined, undefined)).toBe(true);
    expect(adminAuthorizationHeaders(undefined)).toEqual({});
  });

  it('requires an exact bearer token when configured', () => {
    const token = 'admin-session-token';
    expect(adminBearerMatches(undefined, token)).toBe(false);
    expect(adminBearerMatches('Basic admin-session-token', token)).toBe(false);
    expect(adminBearerMatches('Bearer wrong', token)).toBe(false);
    expect(adminBearerMatches(['Bearer admin-session-token'], token)).toBe(false);
    expect(adminBearerMatches(`Bearer ${token}`, token)).toBe(true);
  });

  it('adds the configured bearer to trusted internal callers', () => {
    expect(adminAuthorizationHeaders('admin-session-token')).toEqual({
      Authorization: 'Bearer admin-session-token',
    });
  });

  it('captures and removes the supervisor credential before child inheritance', () => {
    const env = {
      IDACC_ADMIN_TOKEN: 'manager-memory-only',
      BRAIN_TOKEN: 'brain-agent-compatible',
      PATH: '/usr/bin',
    };
    expect(captureAdminToken(env)).toBe('manager-memory-only');
    expect(env).not.toHaveProperty('IDACC_ADMIN_TOKEN');
    expect(env.BRAIN_TOKEN).toBe('brain-agent-compatible');
  });
});
