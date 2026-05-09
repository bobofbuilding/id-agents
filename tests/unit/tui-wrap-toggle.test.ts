// SPDX-License-Identifier: MIT
/**
 * TUI text-wrap toggle defaults and render propagation.
 */

import React from 'react';
import { Box, Text, render as inkRender } from 'ink';
import { Writable, PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { AgentsTable } from '../../src/tui/components/AgentsTable.js';
import { ConfigDetail } from '../../src/tui/components/ConfigDetail.js';
import { ConfigsList } from '../../src/tui/components/ConfigsList.js';
import { Footer } from '../../src/tui/components/Footer.js';
import { HelpViewImpl } from '../../src/tui/components/HelpView.js';
import { NewsView } from '../../src/tui/components/NewsView.js';
import type { Agent, NewsItem } from '../../src/tui/api/types.js';
import {
  isWrapToggleInput,
  textWrapMode,
  toggleWrapEnabled,
  type TextWrapMode,
} from '../../src/tui/util/wrap.js';

function childrenOf(value: unknown): unknown[] {
  if (value == null || typeof value === 'boolean') return [];
  if (Array.isArray(value)) return value.flatMap(childrenOf);
  return [value];
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

const agent: Agent = {
  id: 'agent-1',
  name: 'worker-with-a-long-name',
  port: 4123,
  status: 'running',
  health: 'ok',
  model: 'gpt-5.4',
  createdAt: 1,
  metadata: { runtime: 'claude-code-cli' },
};

const newsItem: NewsItem = {
  type: 'notify',
  timestamp: 1_700_000_000_000,
  message: 'a very long message that should switch between truncation and wrapping',
  data: { from: 'manager' },
};

function renderAgents(wrapMode: TextWrapMode): React.ReactElement {
  return AgentsTable({
    agents: [agent],
    uptimeById: new Map([['agent-1', '1m']]),
    newsColorById: new Map([['agent-1', 'gray']]),
    memBytesById: new Map([['agent-1', 1024]]),
    totalMemoryLabel: '1 KB',
    totalMemoryColor: 'green',
    selectedIndex: 0,
    windowStart: 0,
    windowSize: 1,
    loading: false,
    error: null,
    nowMs: 1_700_000_000_000,
    wrapMode,
  });
}

function renderNews(wrapMode: TextWrapMode): React.ReactElement {
  return NewsView({
    agentName: 'worker',
    items: [newsItem],
    loading: false,
    error: null,
    windowStart: 0,
    windowSize: 1,
    selectedIndex: 0,
    messageWidth: 20,
    cooldownEpoch: 1_700_000_000_000,
    wrapMode,
  });
}

describe('TUI wrap toggle', () => {
  it('defaults to truncate-end and flips on w', () => {
    let enabled = false;
    expect(textWrapMode(enabled)).toBe('truncate-end');
    expect(isWrapToggleInput('w')).toBe(true);
    expect(isWrapToggleInput('a')).toBe(false);

    enabled = toggleWrapEnabled(enabled);
    expect(textWrapMode(enabled)).toBe('wrap');

    enabled = toggleWrapEnabled(enabled);
    expect(textWrapMode(enabled)).toBe('truncate-end');
  });

  it('shares one wrap mode across scrollable views', () => {
    const shared = textWrapMode(toggleWrapEnabled(false));

    const agentWrapProps = collectProps(renderAgents(shared), (props) => props.wrapMode === shared);
    const newsWrapProps = collectProps(renderNews(shared), (props) => props.wrapMode === shared);

    expect(agentWrapProps.length).toBeGreaterThan(0);
    expect(newsWrapProps.length).toBeGreaterThan(0);
  });

  it('renders HelpView wrap state and documents the global w binding', () => {
    const off = HelpViewImpl({ windowSize: 60, scrollOffset: 0, wrapMode: textWrapMode(false) });
    const on = HelpViewImpl({ windowSize: 60, scrollOffset: 0, wrapMode: textWrapMode(true) });

    expect(textContent(off)).toContain('Toggle wrap');
    expect(collectProps(off, (props) => props.wrap === 'truncate-end' && props.children != null).length).toBeGreaterThan(0);
    expect(collectProps(on, (props) => props.wrap === 'wrap' && props.children != null).length).toBe(0);
  });

  it('renders the footer indicator for the current global wrap state', () => {
    expect(textContent(Footer({ view: 'agents', wrapEnabled: false }))).toContain('w wrap off');
    expect(textContent(Footer({ view: 'news', wrapEnabled: true }))).toContain('w wrap on');
  });

  it('keeps a fixed-height list frame single-line when wrap is enabled', async () => {
    const frame = await renderInkFrame(
      React.createElement(
        Box,
        { flexDirection: 'column' },
        React.createElement(ConfigsList, {
          entries: [
            {
              name: 'long',
              relativePath: 'configs/agents/frontend-react/skills/systematic-debugging/extremely-long-file-name-that-wraps.yaml',
              absolutePath: '/tmp/long.yaml',
              mtimeMs: 1_700_000_000_000,
            },
            {
              name: 'short',
              relativePath: 'short.yaml',
              absolutePath: '/tmp/short.yaml',
              mtimeMs: 1_700_000_000_000,
            },
          ],
          selectedIndex: 0,
          windowStart: 0,
          windowSize: 4,
          wrapMode: 'wrap',
        }),
        React.createElement(Text, null, 'FOOTER_SENTINEL'),
      ),
      50,
    );

    expect(visibleLines(frame)).toHaveLength(11);
    expect(frame).toContain('short.yaml');
    expect(frame).toContain('FOOTER_SENTINEL');
  });

  it('wraps detail text into scrollable visual lines before padding', async () => {
    const frame = await renderInkFrame(
      React.createElement(
        Box,
        { flexDirection: 'column' },
        React.createElement(ConfigDetail, {
          config: {
            name: 'demo',
            relativePath: 'demo.yaml',
            absolutePath: '/tmp/demo.yaml',
            mtimeMs: 1_700_000_000_000,
          },
          contents: 'alpha beta gamma delta epsilon zeta eta theta iota kappa',
          error: null,
          positionLabel: 'config 1 of 1',
          windowSize: 4,
          scrollOffset: 0,
          contentWidth: 20,
          wrapMode: 'wrap',
        }),
        React.createElement(Text, null, 'FOOTER_SENTINEL'),
      ),
      50,
    );

    expect(visibleLines(frame)).toHaveLength(10);
    expect(frame).toContain('alpha beta gamma');
    expect(frame).toContain('ta epsilon zeta eta');
    expect(frame).toContain('FOOTER_SENTINEL');
  });
});

async function renderInkFrame(node: React.ReactElement, columns: number): Promise<string> {
  let output = '';
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString('utf8');
      callback();
    },
  }) as Writable & { columns: number; rows: number; isTTY: boolean };
  stdout.columns = columns;
  stdout.rows = 12;
  stdout.isTTY = true;
  const stdin = new PassThrough();
  const stderr = new PassThrough();
  const instance = inkRender(node, { stdout, stdin, stderr, debug: true, patchConsole: false });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const frame = stripAnsi(output);
  instance.unmount();
  return frame;
}

function visibleLines(frame: string): string[] {
  return frame.split('\n').filter((line) => line.length > 0);
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9?;]*[A-Za-z]/g, '');
}
