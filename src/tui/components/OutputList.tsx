import React from 'react';
import { Box, Text } from 'ink';
import { padRight } from '../util/format.js';
import { formatBytes, type OutputFileRow } from '../util/output-files.js';

interface OutputListProps {
  agentName: string | null;
  entries: OutputFileRow[];
  selectedIndex: number;
  windowStart: number;
  windowSize: number;
  error: string | null;
}

const COLS = {
  marker: 2,
  file: 44,
  size: 10,
  modified: 16,
} as const;

const GAP = '  ';

export function OutputList(props: OutputListProps): React.ReactElement {
  const { agentName, entries, selectedIndex, windowStart, windowSize, error } = props;
  const total = entries.length;
  const windowEnd = Math.min(total, windowStart + windowSize);
  const visible = entries.slice(windowStart, windowEnd);
  const hiddenAbove = windowStart;
  const hiddenBelow = total - windowEnd;
  const emptyLine = error ?? `no files found in ${agentName ?? '<agent>'}/output/`;

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold>Output · {agentName ?? '(none)'} ({total})</Text>
        <Text dimColor>{agentName ? `${agentName}/output/` : 'output/'}</Text>
      </Box>
      <Header />
      <Text dimColor>{hiddenAbove > 0 ? `↑ ${hiddenAbove} more above` : ' '}</Text>
      {visible.length === 0 ? (
        <Text color={error ? 'red' : undefined} dimColor={!error}>{emptyLine}</Text>
      ) : (
        visible.map((row, i) => (
          <Row key={row.name} row={row} selected={windowStart + i === selectedIndex} />
        ))
      )}
      {Array.from(
        { length: Math.max(0, windowSize - Math.max(visible.length, visible.length === 0 ? 1 : 0)) },
        (_, i) => (
          <Text key={`pad-${i}`}> </Text>
        ),
      )}
      <Text dimColor>{hiddenBelow > 0 ? `↓ ${hiddenBelow} more below` : ' '}</Text>
    </Box>
  );
}

function Header(): React.ReactElement {
  return (
    <Text bold dimColor wrap="truncate-end">
      {padRight('', COLS.marker)}
      {padRight('FILE', COLS.file)}
      {GAP}
      {padRight('SIZE', COLS.size)}
      {GAP}
      {padRight('MODIFIED', COLS.modified)}
    </Text>
  );
}

function Row(props: { row: OutputFileRow; selected: boolean }): React.ReactElement {
  const { row, selected } = props;
  const marker = selected ? '▶ ' : '  ';
  return (
    <Text inverse={selected} wrap="truncate-end">
      {marker}
      {padRight(row.name, COLS.file)}
      {GAP}
      {padRight(formatBytes(row.size), COLS.size)}
      {GAP}
      {padRight(formatMtime(row.mtimeMs), COLS.modified)}
    </Text>
  );
}

function formatMtime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}
