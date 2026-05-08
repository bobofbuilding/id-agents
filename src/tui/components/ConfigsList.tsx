import React from 'react';
import { Box, Text } from 'ink';
import { padRight } from '../util/format.js';
import type { ConfigFileRow } from '../util/configs.js';
import type { TextWrapMode } from '../util/wrap.js';

interface ConfigsListProps {
  entries: ConfigFileRow[];
  selectedIndex: number;
  windowStart: number;
  windowSize: number;
  wrapMode: TextWrapMode;
}

const COLS = {
  marker: 2,
  file: 48,
  modified: 16,
} as const;

const FILE_MODIFIED_GAP = '  ';

export function ConfigsList(props: ConfigsListProps): React.ReactElement {
  const { entries, selectedIndex, windowStart, windowSize, wrapMode } = props;
  const total = entries.length;
  const windowEnd = Math.min(total, windowStart + windowSize);
  const visible = entries.slice(windowStart, windowEnd);
  const hiddenAbove = windowStart;
  const hiddenBelow = total - windowEnd;

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold>Configs ({total})</Text>
        <Text dimColor>configs/*.yaml</Text>
      </Box>
      <Header wrapMode={wrapMode} />
      <Text dimColor>{hiddenAbove > 0 ? `↑ ${hiddenAbove} more above` : ' '}</Text>
      {visible.length === 0 ? (
        <Text dimColor>no YAML config files found in configs/</Text>
      ) : (
        visible.map((row, i) => (
          <Row key={row.relativePath} row={row} selected={windowStart + i === selectedIndex} wrapMode={wrapMode} />
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

function Header(props: { wrapMode: TextWrapMode }): React.ReactElement {
  return (
    <Text bold dimColor wrap={props.wrapMode}>
      {padRight('', COLS.marker)}
      {padRight('FILE', COLS.file)}
      {FILE_MODIFIED_GAP}
      {padRight('MODIFIED', COLS.modified)}
    </Text>
  );
}

function Row(props: { row: ConfigFileRow; selected: boolean; wrapMode: TextWrapMode }): React.ReactElement {
  const { row, selected, wrapMode } = props;
  const marker = selected ? '▶ ' : '  ';
  return (
    <Text inverse={selected} wrap={wrapMode}>
      {marker}
      {padRight(row.relativePath, COLS.file)}
      {FILE_MODIFIED_GAP}
      {padRight(formatMtime(row.mtimeMs), COLS.modified)}
    </Text>
  );
}

function formatMtime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}
