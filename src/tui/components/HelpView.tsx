import React from 'react';
import { Box, Text } from 'ink';
import { catalogEntriesByTier, type RiskTier } from '../commands/registry.js';

interface HelpViewProps {
  windowSize: number;
  scrollOffset: number;
}

// Outer border (2) + header (1) + spacer (1) = 4 rows that don't belong to the
// scrollable list. App.tsx subtracts this from terminal rows so the list gets
// the rest.
export const HELP_VIEW_CHROME_ROWS = 4;

// ── Keybinding groups (in-app keybindings App.tsx's useInput wires) ──
const VIEW_BINDINGS: Array<[string, string]> = [
  ['a', 'Agents'],
  ['t', 'Tasks'],
  ['n', 'News'],
  ['c', 'Calendar'],
  ['h', 'Heartbeats'],
  ['l', 'Library'],
  ['s', 'Skills'],
];

const NAVIGATE_BINDINGS: Array<[string, string]> = [
  ['↑ ↓', 'Move row'],
  ['j k', 'Move row / scroll'],
  ['PgUp/Dn', 'Move page'],
  ['→', 'Open detail'],
  ['← Esc', 'Back'],
  ['Tab', 'Cycle team'],
];

const GLOBAL_BINDINGS: Array<[string, string]> = [
  ['?', 'Toggle help'],
  ['q', 'Quit'],
  ['^C', 'Force quit'],
];

type Row =
  | { kind: 'section'; title: string; color: string; count?: number }
  | { kind: 'kbd'; key: string; description: string }
  | { kind: 'cmd'; name: string; description: string; tier: RiskTier }
  | { kind: 'spacer' };

const TIER_LABEL: Record<RiskTier, string> = {
  safe: 'Safe',
  powerful: 'Powerful',
  destructive: 'Destructive',
};

const TIER_COLOR: Record<RiskTier, string> = {
  safe: 'green',
  powerful: 'yellow',
  destructive: 'red',
};

const TIER_ORDER: RiskTier[] = ['safe', 'powerful', 'destructive'];

function buildRows(): Row[] {
  const rows: Row[] = [];
  rows.push({ kind: 'section', title: 'Views', color: 'cyan' });
  for (const [key, desc] of VIEW_BINDINGS) rows.push({ kind: 'kbd', key, description: desc });
  rows.push({ kind: 'spacer' });

  const grouped = catalogEntriesByTier();
  for (const tier of TIER_ORDER) {
    const entries = grouped[tier];
    rows.push({ kind: 'section', title: TIER_LABEL[tier], color: TIER_COLOR[tier], count: entries.length });
    for (const spec of entries) {
      rows.push({ kind: 'cmd', name: spec.name, description: spec.description, tier });
    }
    rows.push({ kind: 'spacer' });
  }

  rows.push({ kind: 'section', title: 'Navigate', color: 'cyan' });
  for (const [key, desc] of NAVIGATE_BINDINGS) rows.push({ kind: 'kbd', key, description: desc });
  rows.push({ kind: 'spacer' });

  rows.push({ kind: 'section', title: 'Global', color: 'cyan' });
  for (const [key, desc] of GLOBAL_BINDINGS) rows.push({ kind: 'kbd', key, description: desc });

  return rows;
}

const NAME_COL_WIDTH = 16;

function renderRow(row: Row, key: string): React.ReactElement {
  if (row.kind === 'spacer') return <Text key={key}> </Text>;
  if (row.kind === 'section') {
    return (
      <Text key={key} bold color={row.color}>
        {row.title}
        {row.count !== undefined ? <Text dimColor>{`  (${row.count})`}</Text> : null}
      </Text>
    );
  }
  if (row.kind === 'kbd') {
    return (
      <Box key={key}>
        <Box width={NAME_COL_WIDTH}>
          <Text color="yellow">{`  ${row.key}`}</Text>
        </Box>
        <Text wrap="truncate-end">{row.description}</Text>
      </Box>
    );
  }
  return (
    <Box key={key}>
      <Box width={NAME_COL_WIDTH}>
        <Text color={TIER_COLOR[row.tier]}>{`  /${row.name}`}</Text>
      </Box>
      <Text wrap="truncate-end">{row.description}</Text>
    </Box>
  );
}

export function HelpViewImpl(props: HelpViewProps): React.ReactElement {
  const rows = buildRows();
  const total = rows.length;
  const maxStart = Math.max(0, total - props.windowSize);
  const start = Math.min(Math.max(0, props.scrollOffset), maxStart);
  const visible = rows.slice(start, start + props.windowSize);
  const padCount = Math.max(0, props.windowSize - visible.length);
  const endLineNo = start + visible.length;

  const cmdCount = rows.filter((r) => r.kind === 'cmd').length;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">
          Help · {cmdCount} commands
        </Text>
        <Text dimColor>
          {total} lines · {total === 0 ? 0 : start + 1}–{endLineNo} · ↑↓/jk scroll · Esc / ? close
        </Text>
      </Box>
      <Text dimColor> </Text>
      {visible.map((row, i) => renderRow(row, `help-row-${start + i}`))}
      {Array.from({ length: padCount }, (_, i) => (
        <Text key={`help-pad-${i}`}> </Text>
      ))}
    </Box>
  );
}

export const HelpView = React.memo(HelpViewImpl);
