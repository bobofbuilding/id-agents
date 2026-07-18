// SPDX-License-Identifier: MIT
/** restap-profile: metadata extraction + the TTL-cached manager self-lookup
 * used by agent servers to publish bio/handles in /.well-known/restap.json.
 * (The full manager-route → restap round-trip is covered in
 * tests/integration/profile-bio-handles.test.ts.) */

import { describe, expect, it } from 'vitest';
import { createSelfProfileSource, extractProfile } from '../../src/lib/restap-profile.js';

describe('extractProfile', () => {
  it('extracts bio and string-valued handles', () => {
    expect(
      extractProfile({ bio: 'Builds things.', handles: { x: '@a', github: 'a-gh' }, other: 1 }),
    ).toEqual({ bio: 'Builds things.', handles: { x: '@a', github: 'a-gh' } });
  });

  it('returns null when neither field is present or metadata is not an object', () => {
    expect(extractProfile({})).toBeNull();
    expect(extractProfile({ name: 'x', runtime: 'claude' })).toBeNull();
    expect(extractProfile(null)).toBeNull();
    expect(extractProfile('str')).toBeNull();
    expect(extractProfile(undefined)).toBeNull();
  });

  it('filters non-string handle values and empty strings; supports partial profiles', () => {
    expect(extractProfile({ handles: { x: '@a', bad: 7, empty: '' } })).toEqual({
      handles: { x: '@a' },
    });
    expect(extractProfile({ bio: 'only bio' })).toEqual({ bio: 'only bio' });
    expect(extractProfile({ bio: '', handles: [] })).toBeNull();
  });
});

describe('createSelfProfileSource', () => {
  const managerBody = (agents: unknown) =>
    ({ ok: true, json: async () => ({ agents }) }) as unknown as Response;

  it('prefers locally-held (pushed) metadata and skips fetching', async () => {
    let fetchCalls = 0;
    const source = createSelfProfileSource({
      agentName: 'dev',
      getLocal: () => ({ bio: 'local bio' }),
      fetchImpl: async () => {
        fetchCalls++;
        return managerBody([]);
      },
    });
    expect(await source()).toEqual({ bio: 'local bio' });
    expect(fetchCalls).toBe(0);
  });

  it('falls back to a manager self-lookup and caches for the TTL', async () => {
    let fetchCalls = 0;
    let clock = 0;
    const source = createSelfProfileSource({
      agentName: 'dev',
      managerUrl: 'http://mgr.test',
      team: 't',
      ttlMs: 1000,
      now: () => clock,
      fetchImpl: async (url, init) => {
        fetchCalls++;
        expect(String(url)).toBe('http://mgr.test/agents');
        expect((init?.headers as Record<string, string>)['X-Id-Team']).toBe('t');
        return managerBody([
          { name: 'other', metadata: { bio: 'not me' } },
          { name: 'dev', metadata: { bio: 'from manager', handles: { x: '@dev' } } },
        ]);
      },
    });
    expect(await source()).toEqual({ bio: 'from manager', handles: { x: '@dev' } });
    expect(await source()).toEqual({ bio: 'from manager', handles: { x: '@dev' } });
    expect(fetchCalls).toBe(1); // cached within TTL
    clock = 1500;
    await source();
    expect(fetchCalls).toBe(2); // refreshed after TTL
  });

  it('keeps the last known value on fetch errors and non-OK responses', async () => {
    let clock = 0;
    let mode: 'good' | 'boom' | 'http500' = 'good';
    const source = createSelfProfileSource({
      agentName: 'dev',
      ttlMs: 10,
      now: () => clock,
      fetchImpl: async () => {
        if (mode === 'boom') throw new Error('net down');
        if (mode === 'http500') return { ok: false, json: async () => ({}) } as unknown as Response;
        return managerBody([{ name: 'dev', metadata: { bio: 'v1' } }]);
      },
    });
    expect(await source()).toEqual({ bio: 'v1' });
    mode = 'boom';
    clock = 100;
    expect(await source()).toEqual({ bio: 'v1' }); // stale on error
    mode = 'http500';
    clock = 200;
    expect(await source()).toEqual({ bio: 'v1' }); // stale on non-OK
  });

  it('returns null (not a throw) when the agent has no profile or is missing', async () => {
    const source = createSelfProfileSource({
      agentName: 'dev',
      ttlMs: 10,
      fetchImpl: async () => managerBody([{ name: 'dev', metadata: {} }]),
    });
    expect(await source()).toBeNull();
  });
});
