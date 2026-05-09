// SPDX-License-Identifier: MIT
/**
 * TUI command-result table detection and rendering.
 */

import React from 'react';
import { describe, expect, it } from 'vitest';
import { CommandResultTable } from '../../src/tui/components/CommandResultTable.js';
import { detectTabularResult } from '../../src/tui/util/tabular.js';

function childrenOf(value: unknown): unknown[] {
  if (value == null || typeof value === 'boolean') return [];
  if (Array.isArray(value)) return value.flatMap(childrenOf);
  return [value];
}

function textContent(root: unknown): string {
  let out = '';
  const visit = (node: unknown): void => {
    if (typeof node === 'string' || typeof node === 'number') {
      out += String(node);
      return;
    }
    if (!React.isValidElement(node)) return;
    const props = node.props as Record<string, unknown>;
    for (const child of childrenOf(props.children)) visit(child);
  };
  visit(root);
  return out;
}

function collectProps(root: unknown, predicate: (props: Record<string, unknown>) => boolean): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const visit = (node: unknown): void => {
    if (!React.isValidElement(node)) return;
    const props = node.props as Record<string, unknown>;
    if (predicate(props)) out.push(props);
    for (const child of childrenOf(props.children)) visit(child);
  };
  visit(root);
  return out;
}

describe('detectTabularResult', () => {
  it('detects common command result arrays', () => {
    const cases = [
      { queries: [{ id: 'q1', type: 'talk' }, { id: 'q2', type: 'notify' }] },
      { agents: [{ name: 'tui', status: 'running' }, { name: 'cli', status: 'running' }] },
      { files: [{ name: 'report.md', size: 12, mtime: 1_700_000_000_000 }] },
      { teams: [{ id: 't1', name: 'idchain', agentCount: 2, createdAt: 1_700_000_000_000 }] },
    ];

    expect(cases.map((value) => detectTabularResult(value)?.fieldName)).toEqual([
      'queries',
      'agents',
      'files',
      'teams',
    ]);
  });

  it('rejects non-tabular shapes', () => {
    expect(detectTabularResult({ id: 'q1', type: 'talk' })).toBeNull();
    expect(detectTabularResult({ meta: { status: 'ok' } })).toBeNull();
    expect(detectTabularResult({ queries: [{ id: 'q1' }, 'q2'] })).toBeNull();
    expect(detectTabularResult({ queries: [] })).toBeNull();
    expect(detectTabularResult({ queries: [{ id: 'q1' }], agents: [{ name: 'tui' }] })).toBeNull();
    expect(detectTabularResult({ rows: [{ id: '1' }, { name: 'orphan' }] })).toBeNull();
  });

  it('detects top-level arrays of plain objects (e.g. bulk lifecycle fan-out)', () => {
    const detection = detectTabularResult([
      { agent: 'researcher', action: 'rebuild', ok: true },
      { agent: 'coder', action: 'rebuild', ok: true },
    ]);
    expect(detection).not.toBeNull();
    expect(detection?.fieldName).toBe('rows');
    expect(detection?.rows).toHaveLength(2);
    // Top-level array detection still rejects empty / non-object members.
    expect(detectTabularResult([])).toBeNull();
    expect(detectTabularResult(['a', 'b'])).toBeNull();
  });
});

describe('CommandResultTable', () => {
  it('renders header, separator, aligned cells, and truncated long values', () => {
    const tree = CommandResultTable({
      rows: [
        {
          id: 'q1',
          type: 'talk',
          ok: true,
          timestamp: 1_700_000_000_000,
          payload: { nested: ['value'] },
          message: 'x'.repeat(45),
        },
      ],
      scroll: 0,
      windowSize: 3,
    });
    const text = textContent(tree);

    expect(text).toContain('id   type');
    expect(text).toContain('───');
    expect(text).toContain('q1');
    expect(text).toContain('true');
    expect(text).toContain('2023-11-14T22:13:20Z');
    expect(text).toContain('{"nested":["value"]}');
    expect(text).toContain(`${'x'.repeat(39)}…`);

    const boldRows = collectProps(tree, (props) => props.bold === true && props.children != null);
    expect(textContent(boldRows[0]?.children)).toContain('id');
  });

  it('renders the empty-rows affordance', () => {
    const tree = CommandResultTable({ rows: [], scroll: 0, windowSize: 3 });
    expect(textContent(tree)).toBe('(no rows)');
  });

  it('normalizes multiline and tabbed cells onto one rendered line', () => {
    const tree = CommandResultTable({
      rows: [
        {
          agent: 'tui',
          error: 'first line\nsecond\tvalue\r\nthird line',
        },
      ],
      scroll: 0,
      windowSize: 3,
    });
    const text = textContent(tree);

    expect(text).toContain('first line second value third line');
    expect(text).not.toContain('\nsecond');
    expect(text).not.toContain('\t');
  });
});
