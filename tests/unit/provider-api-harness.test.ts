import { describe, expect, it } from 'vitest';

import {
  callOpenAiToolWithinBoundary,
  filterOpenAiMcpServersForAllowlist,
  filterOpenAiToolsForAllowlist,
  openAiToolExecutionSet,
  type OpenAiTool,
} from '../../src/harness/mcp-client.js';
import { endpoint } from '../../src/harness/provider-api.js';

describe('provider API endpoint construction', () => {
  it('maps native Ollama bases to the OpenAI-compatible v1 endpoint', () => {
    expect(endpoint('http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(endpoint('http://localhost:11434/')).toBe('http://localhost:11434/v1/chat/completions');
  });

  it('preserves explicit OpenAI-compatible provider bases and endpoints', () => {
    expect(endpoint('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(endpoint('https://openrouter.ai/api/v1')).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(endpoint('https://example.test/v1/chat/completions')).toBe('https://example.test/v1/chat/completions');
  });
});

describe('OpenAI-compatible MCP tool exposure', () => {
  const tools: OpenAiTool[] = [
    {
      type: 'function',
      function: { name: 'brain__search', parameters: { type: 'object' } },
    },
    {
      type: 'function',
      function: { name: 'files__read', parameters: { type: 'object' } },
    },
  ];

  it('preserves runtime defaults only when allowedTools is omitted', () => {
    expect(filterOpenAiToolsForAllowlist(tools, undefined)).toBe(tools);
  });

  it('matches full exposed and canonical names while rejecting ambiguous bare names', () => {
    expect(filterOpenAiToolsForAllowlist(tools, ['brain__search'])).toEqual([tools[0]]);
    expect(filterOpenAiToolsForAllowlist(tools, ['mcp__files__read'])).toEqual([tools[1]]);
    expect(filterOpenAiToolsForAllowlist(tools, ['read'])).toEqual([]);
    expect(filterOpenAiToolsForAllowlist(tools, [])).toEqual([]);
  });

  it('does not cross-match two servers that publish the same bare tool name', () => {
    const duplicatedBareName: OpenAiTool[] = [
      {
        type: 'function',
        function: { name: 'brain__read', parameters: { type: 'object' } },
      },
      {
        type: 'function',
        function: { name: 'files__read', parameters: { type: 'object' } },
      },
    ];
    expect(filterOpenAiToolsForAllowlist(duplicatedBareName, ['read'])).toEqual([]);
    expect(filterOpenAiToolsForAllowlist(
      duplicatedBareName,
      ['mcp__brain__read'],
    )).toEqual([duplicatedBareName[0]]);
  });

  it('does not start servers outside an explicit full-name boundary', () => {
    const servers = [
      { name: 'brain', command: 'brain-mcp' },
      { name: 'files', command: 'files-mcp' },
    ];
    expect(filterOpenAiMcpServersForAllowlist(
      servers,
      ['mcp__brain__search'],
    )).toEqual([servers[0]]);
    expect(filterOpenAiMcpServersForAllowlist(
      servers,
      ['files__read'],
    )).toEqual([servers[1]]);
    expect(filterOpenAiMcpServersForAllowlist(servers, ['Read'])).toEqual([]);
    expect(filterOpenAiMcpServersForAllowlist(servers, [])).toEqual([]);
    expect(filterOpenAiMcpServersForAllowlist(servers, undefined)).toEqual(servers);
  });

  it('blocks a malicious unadvertised call before either provider or Ollama can reach MCP', async () => {
    const advertised = filterOpenAiToolsForAllowlist(tools, ['brain__search']);
    const executable = openAiToolExecutionSet(advertised);
    const calls: string[] = [];
    const hub = {
      callTool: async (name: string) => {
        calls.push(name);
        return { text: 'executed', isError: false };
      },
    };

    const denied = await callOpenAiToolWithinBoundary(
      hub,
      executable,
      { function: { name: 'files__read', arguments: '{}' } },
    );
    expect(denied).toMatchObject({ isError: true });
    expect(denied.text).toMatch(/outside the exact advertised tool boundary/i);
    expect(calls).toEqual([]);

    const allowed = await callOpenAiToolWithinBoundary(
      hub,
      executable,
      { function: { name: 'brain__search', arguments: '{"query":"safe"}' } },
    );
    expect(allowed).toEqual({ text: 'executed', isError: false });
    expect(calls).toEqual(['brain__search']);
  });

  it('rejects parameterized expressions in OpenAI-compatible exact boundaries', () => {
    expect(() => filterOpenAiToolsForAllowlist(
      tools,
      ['brain__search(query:*)'],
    )).toThrow(/whole tool names/i);
  });
});
