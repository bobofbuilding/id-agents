// SPDX-License-Identifier: MIT

import React from 'react';
import { Box, Text } from 'ink';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OutputDetail } from '../../src/tui/components/OutputDetail.js';
import { OutputList } from '../../src/tui/components/OutputList.js';
import {
  isTextOutputFile,
  listOutputFiles,
  readOutputFileDetail,
  type OutputFileRow,
} from '../../src/tui/util/output-files.js';

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('TUI output file helpers', () => {
  it('uses the text extension whitelist and treats extensionless files as text', () => {
    for (const name of [
      'report.md',
      'data.JSON',
      'config.yaml',
      'trace.log',
      'view.tsx',
      'script',
      'README',
      '.env',
    ]) {
      expect(isTextOutputFile(name), name).toBe(true);
    }

    for (const name of ['image.png', 'deck.pdf', 'archive.zip', 'blob.bin', 'program.exe']) {
      expect(isTextOutputFile(name), name).toBe(false);
    }
  });

  it('lists direct output files from an agent working directory by newest mtime first', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'id-agents-tui-output-'));
    tmpRoots.push(root);
    const outputDir = path.join(root, 'output');
    mkdirSync(path.join(outputDir, 'nested'), { recursive: true });
    const older = path.join(outputDir, 'older.md');
    const newer = path.join(outputDir, 'newer.json');
    writeFileSync(older, '# Older\n');
    writeFileSync(newer, '{"new":true}\n');
    writeFileSync(path.join(outputDir, 'nested', 'ignored.md'), 'ignored\n');
    const oldDate = new Date('2025-01-01T00:00:00Z');
    const newDate = new Date('2025-01-02T00:00:00Z');
    touch(older, oldDate);
    touch(newer, newDate);

    const rows = listOutputFiles(root);

    expect(rows.map((row) => row.name)).toEqual(['newer.json', 'older.md']);
    expect(rows[0]?.absolutePath).toBe(newer);
    expect(rows.every((row) => row.size > 0)).toBe(true);
  });

  it('does not read non-whitelisted binary extensions for detail bodies', () => {
    const row: OutputFileRow = {
      name: 'chart.png',
      absolutePath: '/path/that/does/not/exist/chart.png',
      size: 2048,
      mtimeMs: 1,
    };

    expect(readOutputFileDetail(row)).toBe('(binary file: chart.png, 2.0 KB)');
  });
});

describe('TUI output components', () => {
  const rows: OutputFileRow[] = [
    row('report.md', 120, 1_700_000_000_000),
    row('chart.png', 2048, 1_700_000_060_000),
  ];

  it('renders a selectable output list with size and modified columns', () => {
    const text = collectText(
      React.createElement(OutputList, {
        agentName: 'cto',
        entries: rows,
        selectedIndex: 1,
        windowStart: 0,
        windowSize: 4,
        wrapMode: 'truncate-end',
        error: null,
      }),
    );

    expect(text).toContain('Output · cto (2)');
    expect(text).toContain('FILE');
    expect(text).toContain('SIZE');
    expect(text).toContain('report.md');
    expect(text).toContain('▶ chart.png');
  });

  it('renders a scrollable output detail body', () => {
    const text = collectText(
      React.createElement(OutputDetail, {
        agentName: 'cto',
        file: rows[0]!,
        contents: '# Report\n\nFindings: clean\n',
        error: null,
        positionLabel: 'file 1 of 2',
        windowSize: 2,
        scrollOffset: 1,
        wrapMode: 'truncate-end',
      }),
    );

    expect(text).toContain('output · cto · report.md');
    expect(text).toContain('file 1 of 2');
    expect(text).toContain('↑ 1 more above');
    expect(text).toContain('Findings: clean');
  });
});

function row(name: string, size: number, mtimeMs: number): OutputFileRow {
  return {
    name,
    absolutePath: `/tmp/${name}`,
    size,
    mtimeMs,
  };
}

function touch(file: string, date: Date): void {
  utimesSync(file, date, date);
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
