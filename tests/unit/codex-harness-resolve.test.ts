import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { codexVersion, resolveCodexExecutable } from '../../src/harness/codex.js';

function currentTarget(): { packageName: string; triple: string; binary: string } | undefined {
  const binary = process.platform === 'win32' ? 'codex.exe' : 'codex';
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return { packageName: '@openai/codex-darwin-arm64', triple: 'aarch64-apple-darwin', binary };
  }
  if (process.platform === 'darwin' && process.arch === 'x64') {
    return { packageName: '@openai/codex-darwin-x64', triple: 'x86_64-apple-darwin', binary };
  }
  if (process.platform === 'linux' && process.arch === 'arm64') {
    return { packageName: '@openai/codex-linux-arm64', triple: 'aarch64-unknown-linux-musl', binary };
  }
  if (process.platform === 'linux' && process.arch === 'x64') {
    return { packageName: '@openai/codex-linux-x64', triple: 'x86_64-unknown-linux-musl', binary };
  }
  if (process.platform === 'win32' && process.arch === 'x64') {
    return { packageName: '@openai/codex-win32-x64', triple: 'x86_64-pc-windows-msvc', binary };
  }
  return undefined;
}

describe('resolveCodexExecutable', () => {
  it('prefers an explicit binary override', () => {
    expect(resolveCodexExecutable({ ID_AGENT_CODEX_BIN: '/tmp/custom-codex' }).command).toBe('/tmp/custom-codex');
  });

  it('preserves an explicit Windows .cmd shim for the portable launcher', () => {
    const resolved = resolveCodexExecutable(
      { ID_AGENT_CODEX_BIN: 'C:\\Users\\consumer\\AppData\\Roaming\\npm\\codex.cmd' },
      'win32',
    );

    expect(resolved.command).toBe('C:\\Users\\consumer\\AppData\\Roaming\\npm\\codex.cmd');
    expect(resolved.native).toBe(false);
  });

  it.runIf(process.platform === 'win32')('reads versions from an npm-generated Windows .cmd shim', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'id-agents-codex-version-'));
    const shim = path.join(root, 'codex.cmd');
    fs.writeFileSync(shim, '@echo off\r\necho codex-cli 0.144.0\r\n');

    expect(codexVersion(shim)).toContain('0.144.0');
  });

  it('resolves npm-installed codex to the native binary behind the node shim', () => {
    const target = currentTarget();
    if (!target) return;

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'id-agents-codex-resolve-'));
    const binDir = path.join(root, 'bin');
    const shim = path.join(binDir, 'codex');
    const native = path.join(root, 'node_modules', target.packageName, 'vendor', target.triple, 'bin', target.binary);
    fs.mkdirSync(path.dirname(native), { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(shim, '#!/usr/bin/env node\n');
    fs.writeFileSync(native, '#!/bin/sh\n');
    fs.chmodSync(shim, 0o755);
    fs.chmodSync(native, 0o755);

    const resolved = resolveCodexExecutable({ PATH: binDir });

    expect(resolved.native).toBe(true);
    expect(resolved.command).toBe(fs.realpathSync(native));
    expect(resolved.managedPackageRoot).toBe(fs.realpathSync(root));
  });
});
