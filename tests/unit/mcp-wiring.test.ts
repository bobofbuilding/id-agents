import { describe, it, expect } from 'vitest';
import { toMcpServerRecord, parseMcpServersEnv } from '../../src/harness/mcp.js';
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
