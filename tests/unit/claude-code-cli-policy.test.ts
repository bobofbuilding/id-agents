import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  claudeCliSpeedSettingsArgs,
  claudeCliStdinInvocation,
  claudeCliToolArgs,
} from '../../src/harness/claude-code-cli.js';

describe('Claude Code CLI harness policy', () => {
  it('restricts available tools for control-plane prompts', () => {
    expect(claudeCliToolArgs({
      executionPolicy: 'control-plane-readonly',
      allowedTools: ['Read', 'Glob', 'Grep'],
    })).toEqual([
      '--tools',
      'Read,Glob,Grep',
      '--allowedTools',
      'Read,Glob,Grep',
    ]);
  });

  it('keeps existing auto-allow behavior for normal work', () => {
    expect(claudeCliToolArgs({
      allowedTools: ['Read', 'Write', 'Edit', 'Bash'],
    })).toEqual([
      '--allowedTools',
      'Read,Write,Edit,Bash',
    ]);
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
