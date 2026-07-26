import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  brainMcpProcessEnv,
  parseBrainMcpArgs,
  parseMcpServersEnv,
  sameMcpServerSnapshot,
  toMcpServerRecord,
} from '../../src/harness/mcp.js';
import type { McpServerSpec } from '../../src/harness/types.js';

describe('toMcpServerRecord — normalize McpServerSpec[] → SDK/.mcp.json record', () => {
  it('maps a stdio server with args + env', () => {
    const specs: McpServerSpec[] = [
      { name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'server-filesystem', '/tmp'], env: { FOO: 'bar' } },
    ];
    expect(toMcpServerRecord(specs)).toEqual({
      fs: { type: 'stdio', command: 'npx', args: ['-y', 'server-filesystem', '/tmp'], env: { FOO: 'bar' } },
    });
  });

  it('defaults missing transport to stdio', () => {
    const out = toMcpServerRecord([{ name: 'x', command: 'run-it' }]);
    expect(out.x).toEqual({ type: 'stdio', command: 'run-it' });
  });

  it('maps http + sse servers with headers', () => {
    const out = toMcpServerRecord([
      { name: 'h', transport: 'http', url: 'https://mcp.example/h', headers: { Authorization: 'Bearer t' } },
      { name: 's', transport: 'sse', url: 'https://mcp.example/s' },
    ]);
    expect(out.h).toEqual({ type: 'http', url: 'https://mcp.example/h', headers: { Authorization: 'Bearer t' } });
    expect(out.s).toEqual({ type: 'sse', url: 'https://mcp.example/s' });
  });

  it('skips entries missing their required fields (no crash)', () => {
    const out = toMcpServerRecord([
      { name: 'no-cmd', transport: 'stdio' }, // stdio needs command
      { name: 'no-url', transport: 'http' }, // http needs url
      { name: '', command: 'anon' }, // missing name
      { name: 'ok', command: 'go' },
    ] as McpServerSpec[]);
    expect(Object.keys(out)).toEqual(['ok']);
  });

  it('returns an empty record for an empty list', () => {
    expect(toMcpServerRecord([])).toEqual({});
  });
});

describe('parseMcpServersEnv — tolerant ID_MCP_SERVERS parsing', () => {
  it('parses a JSON array of specs', () => {
    const specs = [{ name: 'fs', command: 'go' }];
    expect(parseMcpServersEnv(JSON.stringify(specs))).toEqual(specs);
  });
  it('returns undefined for empty/absent/malformed/empty-array', () => {
    expect(parseMcpServersEnv(undefined)).toBeUndefined();
    expect(parseMcpServersEnv('')).toBeUndefined();
    expect(parseMcpServersEnv('not json')).toBeUndefined();
    expect(parseMcpServersEnv('{}')).toBeUndefined();
    expect(parseMcpServersEnv('[]')).toBeUndefined();
  });
});

describe('sameMcpServerSnapshot — compare-and-set protection', () => {
  it('ignores object key ordering without ignoring connection values', () => {
    const expected = [{
      name: 'brain',
      transport: 'stdio' as const,
      command: '/runtime with spaces/electron',
      args: ['/runtime with spaces/brain-mcp.mjs'],
      env: { BRAIN_TOKEN: 'scoped', BRAIN_MCP_BASE_URL: 'http://127.0.0.1:49123' },
    }];
    const reordered = [{
      env: { BRAIN_MCP_BASE_URL: 'http://127.0.0.1:49123', BRAIN_TOKEN: 'scoped' },
      args: ['/runtime with spaces/brain-mcp.mjs'],
      command: '/runtime with spaces/electron',
      transport: 'stdio' as const,
      name: 'brain',
    }];
    const changed = [{ ...expected[0], args: ['/runtime with spaces/other.mjs'] }];
    expect(sameMcpServerSnapshot(expected, reordered)).toBe(true);
    expect(sameMcpServerSnapshot(expected, changed)).toBe(false);
  });

  it('treats list ordering and an attach/detach as reviewed state changes', () => {
    const first = { name: 'a', command: 'a' };
    const second = { name: 'b', command: 'b' };
    expect(sameMcpServerSnapshot([first, second], [second, first])).toBe(false);
    expect(sameMcpServerSnapshot([first], [first, second])).toBe(false);
  });

  it('guards the Manager mutation inside the per-agent lifecycle lock', () => {
    const manager = readFileSync(
      new URL('../../src/agent-manager-db.ts', import.meta.url),
      'utf8',
    );
    expect(manager).toMatch(
      /withAgentLifecycleLock\([\s\S]{0,1200}sameMcpServerSnapshot\([\s\S]{0,700}status:\s*409/,
    );
    expect(manager).toMatch(/MCP attachments changed after review; refresh and retry/);
  });
});

describe('parseBrainMcpArgs — space-safe bundled Brain MCP argv', () => {
  it('preserves an absolute staged script path containing spaces as one argument', () => {
    const script = '/Applications/ID Agents Control Center.app/Contents/Resources/idacc-runtime/brain/brain-mcp.mjs';
    expect(parseBrainMcpArgs(JSON.stringify([script]), undefined, '/unused')).toEqual([script]);
  });

  it('supports multiple explicit JSON arguments without shell parsing', () => {
    expect(parseBrainMcpArgs(
      JSON.stringify(['/runtime with spaces/brain-mcp.mjs', '--profile', 'consumer one']),
      undefined,
      '/unused',
    )).toEqual(['/runtime with spaces/brain-mcp.mjs', '--profile', 'consumer one']);
  });

  it('fails closed for malformed or unsafe JSON argv', () => {
    expect(parseBrainMcpArgs('not-json', undefined, '/default')).toBeNull();
    expect(parseBrainMcpArgs(JSON.stringify([]), undefined, '/default')).toBeNull();
    expect(parseBrainMcpArgs(JSON.stringify(['/ok', 'bad\0arg']), undefined, '/default')).toBeNull();
  });

  it('never whitespace-splits the deprecated legacy value', () => {
    expect(parseBrainMcpArgs(undefined, '/runtime with spaces/brain-mcp.mjs', '/default')).toEqual([
      '/runtime with spaces/brain-mcp.mjs',
    ]);
  });

  it('pins Electron Node mode and the scoped Brain credential in the MCP child env', () => {
    expect(brainMcpProcessEnv('http://127.0.0.1:49123', 'brain-session-token')).toEqual({
      BRAIN_MCP_BASE_URL: 'http://127.0.0.1:49123',
      ELECTRON_RUN_AS_NODE: '1',
      BRAIN_TOKEN: 'brain-session-token',
    });
  });
});
