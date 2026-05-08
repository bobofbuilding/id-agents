// SPDX-License-Identifier: MIT
/**
 * TUI command catalog safety tiers and Phase 4 confirmation defaults.
 */

import { describe, expect, it } from 'vitest';
import {
  catalogEntriesByTier,
  commandConfirmPreview,
  confirmationLevel,
  lookupCommand,
} from '../../src/tui/commands/registry.js';

function command(name: string) {
  const spec = lookupCommand(name);
  expect(spec).not.toBeNull();
  return spec!;
}

describe('TUI command registry tiers', () => {
  it('groups every command under exactly one risk tier', () => {
    const grouped = catalogEntriesByTier();
    const names = Object.values(grouped).flat().map((spec) => spec.name);

    expect(new Set(names).size).toBe(names.length);
    expect(grouped.safe.map((spec) => spec.name)).toContain('help');
    expect(grouped.powerful.map((spec) => spec.name)).toContain('deploy');
    expect(grouped.destructive.map((spec) => spec.name)).toContain('delete');
  });

  it('keeps destructive Phase 4 commands behind exact retype confirmation', () => {
    expect(confirmationLevel(command('delete'), ['worker'])).toBe('retype');
    expect(commandConfirmPreview(command('delete'), ['worker'])).toBe('delete agent worker');

    expect(confirmationLevel(command('cancel'), ['worker'])).toBe('retype');
    expect(confirmationLevel(command('clear'), ['worker'])).toBe('retype');
    expect(confirmationLevel(command('sync-wallets'), [])).toBe('retype');
  });

  it('keeps powerful Phase 3 mutators behind Y/N confirmation by default', () => {
    expect(confirmationLevel(command('agent'), ['worker', 'rebuild'])).toBe('yn');
    expect(commandConfirmPreview(command('agent'), ['worker', 'rebuild'])).toBe('rebuild agent worker');
    expect(confirmationLevel(command('agent'), ['worker', 'probe'])).toBe('none');

    expect(confirmationLevel(command('model'), ['worker', 'gpt-5.4'])).toBe('yn');
    expect(commandConfirmPreview(command('model'), ['worker', 'gpt-5.4'])).toBe(
      'set model gpt-5.4 on agent worker',
    );
    expect(confirmationLevel(command('model'), ['worker'])).toBe('none');

    expect(confirmationLevel(command('deploy'), ['idchain'])).toBe('yn');
    expect(confirmationLevel(command('sync'), ['idchain'])).toBe('yn');
    expect(confirmationLevel(command('register'), ['worker'])).toBe('yn');
    expect(confirmationLevel(command('registry'), ['push'])).toBe('yn');
    expect(confirmationLevel(command('heartbeat'), ['enable', 'worker'])).toBe('yn');
    expect(confirmationLevel(command('heartbeat'), ['worker'])).toBe('none');
  });

  it('opts only obvious tabular command results into table rendering', () => {
    expect(command('status').resultRenderer).toBe('table');
    expect(command('teams').resultRenderer).toBe('table');
    expect(command('list').resultRenderer).toBe('table');

    expect(command('meta').resultRenderer).toBeUndefined();
    expect(command('configs').resultRenderer).toBeUndefined();
    expect(command('output').resultRenderer).toBe('table');
  });

  it('routes :configs to a TUI action instead of /remote dispatch', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true, result: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const result = await command('configs').run({
        manager: 'http://127.0.0.1:0',
        executor: 'tui',
        signal: new AbortController().signal,
        args: [],
      });

      expect(result).toEqual({ tuiAction: 'configs' });
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('routes :output <agent> to a scoped TUI action and requires an agent argument', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true, result: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const spec = command('output');
      const ok = await spec.run({
        manager: 'http://127.0.0.1:0',
        executor: 'tui',
        signal: new AbortController().signal,
        args: ['cto'],
      });
      const missing = await spec.run({
        manager: 'http://127.0.0.1:0',
        executor: 'tui',
        signal: new AbortController().signal,
        args: [],
      });

      expect(ok).toEqual({ tuiAction: 'output', agent: 'cto' });
      expect(missing).toEqual({ ok: false, error: 'Usage: :output <agent>' });
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('routes :team <name> through /remote as a safe switch', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true, result: { switched: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const spec = command('team');
      expect(spec.tier).toBe('powerful');
      expect(confirmationLevel(spec, [])).toBe('none');
      expect(confirmationLevel(spec, ['skunkworks'])).toBe('none');
      expect(commandConfirmPreview(spec, ['skunkworks'])).toBeNull();

      await spec.run({
        manager: 'http://127.0.0.1:0',
        executor: 'tui',
        signal: new AbortController().signal,
        args: ['skunkworks'],
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe('http://127.0.0.1:0/remote');
      expect(calls[0]?.init.method).toBe('POST');
      expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
        agent: 'tui',
        command: '/team skunkworks',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('routes :team delete <name> through /remote with retype confirmation preview', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true, result: { success: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const spec = command('team');
      expect(confirmationLevel(spec, ['delete'])).toBe('none');
      expect(confirmationLevel(spec, ['delete', 'foo'])).toBe('retype');
      expect(commandConfirmPreview(spec, ['delete', 'foo'])).toBe('DELETE team foo');

      await spec.run({
        manager: 'http://127.0.0.1:0',
        executor: 'tui',
        signal: new AbortController().signal,
        args: ['delete', 'foo'],
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe('http://127.0.0.1:0/remote');
      expect(calls[0]?.init.method).toBe('POST');
      expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
        agent: 'tui',
        command: '/team delete foo',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('escalates hybrid remove/delete subcommands from Y/N to retype', () => {
    expect(confirmationLevel(command('schedule'), ['add', 'daily'])).toBe('yn');
    expect(confirmationLevel(command('schedule'), ['remove', 'daily'])).toBe('retype');

    expect(confirmationLevel(command('task'), ['claim', 'ship-it'])).toBe('yn');
    expect(confirmationLevel(command('task'), ['delete', 'ship-it'])).toBe('retype');
  });
});
