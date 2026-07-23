import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { KimiCliHarness } from '../../src/harness/kimi-cli.js';

const originalKimiPath = process.env.KIMI_CLI_PATH;

afterEach(() => {
  if (originalKimiPath === undefined) delete process.env.KIMI_CLI_PATH;
  else process.env.KIMI_CLI_PATH = originalKimiPath;
});

describe('KimiCliHarness', () => {
  it('keeps the task out of argv and removes its private prompt file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'id-agents-kimi-harness-test-'));
    const fakeKimi = join(dir, 'kimi');
    writeFileSync(fakeKimi, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const promptIndex = args.indexOf('-p');
const launchPrompt = args[promptIndex + 1];
const promptFile = launchPrompt.split('\\n')[1];
process.stdout.write(JSON.stringify({ args, promptFile, task: fs.readFileSync(promptFile, 'utf8') }));
`);
    chmodSync(fakeKimi, 0o700);
    process.env.KIMI_CLI_PATH = fakeKimi;

    const secretTask = 'private task payload that must not appear on argv';
    const messages = [];
    for await (const message of new KimiCliHarness().run(secretTask, {
      workingDirectory: dir,
      model: 'kimi-code/kimi-for-coding',
    })) {
      messages.push(message);
    }

    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('result');
    const output = JSON.parse(messages[0].content || '{}') as { args: string[]; promptFile: string; task: string };
    expect(output.task).toBe(secretTask);
    expect(output.args.join(' ')).not.toContain(secretTask);
    expect(output.args).toContain('--output-format');
    expect(output.args).toContain('text');
    expect(output.args).toContain('kimi-code/kimi-for-coding');
    expect(existsSync(output.promptFile)).toBe(false);
  });
});
