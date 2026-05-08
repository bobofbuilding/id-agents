// SPDX-License-Identifier: MIT
/**
 * TUI text-wrap toggle defaults and render propagation.
 */

import React from 'react';
import { Text } from 'ink';
import { describe, expect, it } from 'vitest';
import { AgentsTable } from '../../src/tui/components/AgentsTable.js';
import { Footer } from '../../src/tui/components/Footer.js';
import { HelpView } from '../../src/tui/components/HelpView.js';
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
    const off = HelpView({ windowSize: 3, scrollOffset: 0, wrapMode: textWrapMode(false) });
    const on = HelpView({ windowSize: 3, scrollOffset: 0, wrapMode: textWrapMode(true) });

    const keybindGroups = collectProps(off, (props) => Array.isArray((props.group as { rows?: unknown })?.rows));
    expect(JSON.stringify(keybindGroups)).toContain('Toggle wrap');
    expect(collectProps(off, (props) => props.wrap === 'truncate-end' && props.children != null).length).toBeGreaterThan(0);
    expect(collectProps(on, (props) => props.wrap === 'wrap' && props.children != null).length).toBeGreaterThan(0);
  });

  it('renders the footer indicator for the current global wrap state', () => {
    expect(textContent(Footer({ view: 'agents', wrapEnabled: false }))).toContain('w wrap off');
    expect(textContent(Footer({ view: 'news', wrapEnabled: true }))).toContain('w wrap on');
  });
});
