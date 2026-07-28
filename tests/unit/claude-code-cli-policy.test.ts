import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  claudeCliMcpPolicy,
  claudeCliSpeedSettingsArgs,
  claudeCliStdinInvocation,
  claudeCliToolArgs,
  ClaudeCodeCliHarness,
} from '../../src/harness/claude-code-cli.js';

describe('Claude Code CLI harness policy', () => {
  it('restricts available tools for control-plane prompts', () => {
    expect(claudeCliToolArgs({
      executionPolicy: 'control-plane-readonly',
      allowedTools: ['Read', 'Glob', 'Grep'],
    })).toEqual([
      '--setting-sources',
      '',
      '--permission-mode',
      'dontAsk',
      '--tools',
      'Read,Glob,Grep',
      '--allowedTools',
      'Read,Glob,Grep',
    ]);
  });

  it('uses configured tools as the normal exposure and auto-allow boundary', () => {
    expect(claudeCliToolArgs({
      allowedTools: ['Read', 'Write', 'Edit', 'Bash'],
    })).toEqual([
      '--setting-sources',
      '',
      '--permission-mode',
      'dontAsk',
      '--tools',
      'Read,Write,Edit,Bash',
      '--allowedTools',
      'Read,Write,Edit,Bash',
    ]);
  });

  it('distinguishes an omitted boundary from an explicit empty boundary', () => {
    expect(claudeCliToolArgs({})).toEqual([]);
    expect(claudeCliToolArgs({ allowedTools: [] })).toEqual([
      '--setting-sources',
      '',
      '--permission-mode',
      'dontAsk',
      '--tools',
      '',
    ]);
  });

  it('fails closed for named MCP tools because attached CLI servers expose unlisted siblings', () => {
    expect(() => claudeCliToolArgs({
      allowedTools: ['Read', 'mcp__filesystem__read_file'],
    })).toThrow(/cannot enforce an exact named MCP tool boundary/i);
  });

  it('attaches no MCP servers for exact built-in-only or empty boundaries', () => {
    const servers = [
      { name: 'filesystem', command: 'node', args: ['filesystem.js'] },
      { name: 'database', command: 'node', args: ['database.js'] },
    ];
    expect(claudeCliMcpPolicy({
      allowedTools: ['Read'],
      mcpServers: servers,
    })).toEqual({ servers: [], strict: true });
    expect(() => claudeCliMcpPolicy({
      allowedTools: ['Read', 'mcp__filesystem__read_file'],
      mcpServers: servers,
    })).toThrow(/cannot enforce an exact named MCP tool boundary/i);
    expect(claudeCliMcpPolicy({
      allowedTools: [],
      mcpServers: servers,
    })).toEqual({ servers: [], strict: true });
    expect(claudeCliMcpPolicy({
      mcpServers: servers,
    })).toEqual({ servers, strict: true });
    expect(claudeCliMcpPolicy({})).toEqual({ servers: [], strict: false });
  });

  it('overrides broad permission bypass and writes an empty strict MCP config for [Read]', async () => {
    const savedSkipPermissions = process.env.ID_AGENT_SKIP_PERMISSIONS;
    process.env.ID_AGENT_SKIP_PERMISSIONS = 'true';
    try {
      const harness = new ClaudeCodeCliHarness() as any;
      let capturedArgs: string[] = [];
      let capturedMcpConfig: unknown;
      harness.spawnClaude = async (args: string[]) => {
        capturedArgs = [...args];
        const configIndex = args.indexOf('--mcp-config');
        capturedMcpConfig = JSON.parse(readFileSync(args[configIndex + 1], 'utf8'));
        return {
          stdout: JSON.stringify({ type: 'result', result: 'ok' }),
          stderr: '',
          exitCode: 0,
        };
      };
      for await (const _message of harness.run('safe request', {
        allowedTools: ['Read'],
        mcpServers: [{ name: 'filesystem', command: 'node', args: ['filesystem.js'] }],
      })) {
        // Drain the generator so its temp MCP config cleanup runs.
      }

      expect(capturedArgs).not.toContain('--dangerously-skip-permissions');
      expect(capturedArgs).toEqual(expect.arrayContaining([
        '--setting-sources',
        '',
        '--permission-mode',
        'dontAsk',
        '--tools',
        'Read',
        '--mcp-config',
      ]));
      expect(capturedArgs).toContain('--strict-mcp-config');
      expect(capturedMcpConfig).toEqual({ mcpServers: {} });
    } finally {
      if (savedSkipPermissions === undefined) delete process.env.ID_AGENT_SKIP_PERMISSIONS;
      else process.env.ID_AGENT_SKIP_PERMISSIONS = savedSkipPermissions;
    }
  });

  it('rejects parameterized permission expressions instead of widening them to a base tool', () => {
    for (const entry of ['Bash(git:*)', 'Read(/tmp/reviewed/**)']) {
      expect(() => claudeCliToolArgs({
        allowedTools: [entry],
      })).toThrow(/whole tool names/i);
    }
  });

  it('never spawns with an ambient server-wide allow or hook when a named MCP tool is requested', async () => {
    const harness = new ClaudeCodeCliHarness() as any;
    let spawnCalled = false;
    harness.spawnClaude = async () => {
      spawnCalled = true;
      throw new Error('must not spawn');
    };

    await expect((async () => {
      for await (const _message of harness.run('read one reviewed file', {
        allowedTools: ['mcp__filesystem__read_file'],
        mcpServers: [{
          name: 'filesystem',
          command: 'node',
          args: ['filesystem.js'],
        }],
      })) {
        // The boundary must fail before a CLI process or MCP config is created.
      }
    })()).rejects.toThrow(/cannot enforce an exact named MCP tool boundary/i);
    expect(spawnCalled).toBe(false);
  });

  it('fails closed for external text-only conversations on unproven CLI versions', () => {
    expect(() => claudeCliToolArgs({
      executionPolicy: 'external-text-only',
      allowedTools: [],
    })).toThrow(/cannot guarantee external-text-only/i);
  });

  it('uses Claude Code launch settings for explicit per-agent speed', () => {
    expect(claudeCliSpeedSettingsArgs('fast')).toEqual([
      '--settings',
      '{"fastMode":true}',
    ]);
    expect(claudeCliSpeedSettingsArgs('default')).toEqual([
      '--settings',
      '{"fastMode":false}',
    ]);
  });

  it('does not invent settings for missing or unsupported speed values', () => {
    expect(claudeCliSpeedSettingsArgs(undefined)).toEqual([]);
    expect(claudeCliSpeedSettingsArgs('turbo')).toEqual([]);
  });

  it('preserves launch-scoped fast mode when resuming a non-interactive session', () => {
    const prompt = 'continue the reviewed work';
    const invocation = claudeCliStdinInvocation([
      '-p',
      prompt,
      ...claudeCliSpeedSettingsArgs('fast'),
      '--resume',
      'f65d4adc-72c7-4c54-9ec2-c2d80064df37',
      '--output-format',
      'json',
    ]);

    expect(invocation.args).toEqual([
      '-p',
      '--settings',
      '{"fastMode":true}',
      '--resume',
      'f65d4adc-72c7-4c54-9ec2-c2d80064df37',
      '--output-format',
      'json',
    ]);
    expect(invocation.stdin).toBe(prompt);
  });

  it('delivers complete prompts only over direct CLI stdin', () => {
    const prompt = 'line one\n"$(cat /shared/secret)" & echo should-not-run';
    const invocation = claudeCliStdinInvocation([
      '-p',
      prompt,
      '--output-format',
      'json',
      '--model',
      'sonnet',
    ], { CLAUDE_PATH: 'C:\\Tools\\claude.exe' });

    expect(invocation.command).toBe('C:\\Tools\\claude.exe');
    expect(invocation.args).toEqual([
      '-p',
      '--output-format',
      'json',
      '--model',
      'sonnet',
    ]);
    expect(invocation.args).not.toContain(prompt);
    expect(invocation.stdin).toBe(prompt);
  });

  it('preserves a resolved Windows .cmd shim for the portable launcher', () => {
    const prompt = 'private prompt with %TOKEN% & shell metacharacters';
    const invocation = claudeCliStdinInvocation(
      ['-p', prompt],
      { CLAUDE_PATH: 'C:\\Users\\consumer\\AppData\\Roaming\\npm\\claude.cmd' },
      'win32',
    );

    expect(invocation.command).toBe('C:\\Users\\consumer\\AppData\\Roaming\\npm\\claude.cmd');
    expect(invocation.args).not.toContain(prompt);
    expect(invocation.stdin).toBe(prompt);
  });

  it('does not route prompts through bash, cat, or predictable temp files', () => {
    const source = readFileSync(new URL('../../src/harness/claude-code-cli.ts', import.meta.url), 'utf8');
    expect(source).not.toContain("spawn('/bin/bash'");
    expect(source).not.toContain('"$(cat');
    expect(source).not.toContain('claude-prompt-');
    expect(source).toContain('portableSpawn(invocation.command, invocation.args');
  });
});
