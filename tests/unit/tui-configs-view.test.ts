// SPDX-License-Identifier: MIT

import React from 'react';
import { Box, Text } from 'ink';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commandResultConsumesInput } from '../../src/tui/App.js';
import { ConfigDetail } from '../../src/tui/components/ConfigDetail.js';
import { ConfigsList } from '../../src/tui/components/ConfigsList.js';
import { listConfigFiles, type ConfigFileRow } from '../../src/tui/util/configs.js';

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('TUI configs filesystem discovery', () => {
  it('walks configs/ recursively and returns sorted *.yaml rows', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'id-agents-tui-configs-'));
    tmpRoots.push(root);
    const configsDir = path.join(root, 'configs');
    mkdirSync(path.join(configsDir, 'demos'), { recursive: true });
    writeFileSync(path.join(configsDir, 'zeta.yaml'), 'version: "1"\n');
    writeFileSync(path.join(configsDir, 'alpha.yml'), 'ignored: true\n');
    writeFileSync(path.join(configsDir, 'demos', 'demo.yaml'), 'name: demo\n');

    const rows = listConfigFiles(configsDir);

    expect(rows.map((row) => row.relativePath)).toEqual(['demos/demo.yaml', 'zeta.yaml']);
    expect(rows[0]?.name).toBe('demo');
    expect(rows[0]?.absolutePath).toBe(path.join(configsDir, 'demos', 'demo.yaml'));
    expect(rows.every((row) => row.mtimeMs > 0)).toBe(true);
  });

  it('returns an empty list when configs/ is absent', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'id-agents-tui-configs-empty-'));
    tmpRoots.push(root);

    expect(listConfigFiles(path.join(root, 'configs'))).toEqual([]);
  });
});

describe('TUI configs components', () => {
  const rows: ConfigFileRow[] = [
    row('alpha.yaml', 1_700_000_000_000),
    row('demos/demo.yaml', 1_700_000_060_000),
  ];

  it('renders a selectable configs list', () => {
    const text = collectText(
      React.createElement(ConfigsList, {
        entries: rows,
        selectedIndex: 1,
        windowStart: 0,
        windowSize: 4,
        wrapMode: 'truncate-end',
      }),
    );

    expect(text).toContain('Configs (2)');
    expect(text).toContain('FILE');
    expect(text).toContain('alpha.yaml');
    expect(text).toContain('▶ demos/demo.yaml');
  });

  it('renders a scrollable config detail body', () => {
    const text = collectText(
      React.createElement(ConfigDetail, {
        config: rows[1]!,
        contents: 'version: "1"\nagents:\n  - name: tui\n',
        error: null,
        positionLabel: 'config 2 of 2',
        windowSize: 2,
        scrollOffset: 1,
        wrapMode: 'truncate-end',
      }),
    );

    expect(text).toContain('config · demos/demo.yaml');
    expect(text).toContain('config 2 of 2');
    expect(text).toContain('↑ 1 more above');
    expect(text).toContain('agents:');
    expect(text).toContain('  - name: tui');
  });
});

describe('TUI config-detail navigation policy', () => {
  it('does not let an open command result swallow left-arrow view navigation', () => {
    expect(commandResultConsumesInput('', { leftArrow: true }, { canShowJson: false })).toBe(false);
    expect(commandResultConsumesInput('', { upArrow: true }, { canShowJson: false })).toBe(true);
    expect(commandResultConsumesInput('j', {}, { canShowJson: true })).toBe(true);
    expect(commandResultConsumesInput('j', {}, { canShowJson: false })).toBe(false);
  });
});

function row(relativePath: string, mtimeMs: number): ConfigFileRow {
  return {
    name: path.basename(relativePath, '.yaml'),
    relativePath,
    absolutePath: `/tmp/${relativePath}`,
    mtimeMs,
  };
}

function collectText(node: React.ReactNode): string {
  const parts: string[] = [];
  visit(node, parts);
  return parts.join('');
}

function visit(node: React.ReactNode, parts: string[]): void {
  if (node == null || typeof node === 'boolean') return;
  if (typeof node === 'string' || typeof node === 'number') {
    parts.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) visit(child, parts);
    return;
  }
  if (!React.isValidElement(node)) return;
  if (typeof node.type === 'function' && node.type !== Box && node.type !== Text) {
    visit((node.type as (props: unknown) => React.ReactNode)(node.props), parts);
    return;
  }
  visit((node.props as { children?: React.ReactNode }).children, parts);
}
