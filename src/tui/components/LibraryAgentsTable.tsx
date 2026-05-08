import React from 'react';
import { Box, Text } from 'ink';
import { padRight } from '../util/format.js';
import type { LibraryAgentRow } from '../api/manager.js';
import type { TextWrapMode } from '../util/wrap.js';

interface LibraryAgentsTableProps {
  entries: LibraryAgentRow[];
  libraryRoot: string | null;
  errorCount: number;
  selectedIndex: number;
  windowStart: number;
  windowSize: number;
  loading: boolean;
  error: Error | null;
  wrapMode: TextWrapMode;
}

const COLS = {
  marker: 2,
  name: 24,
  shape: 18,
} as const;

const NAME_SHAPE_GAP = '  ';

export function LibraryAgentsTable(props: LibraryAgentsTableProps): React.ReactElement {
  const {
    entries,
    libraryRoot,
    errorCount,
    selectedIndex,
    windowStart,
    windowSize,
    loading,
    error,
    wrapMode,
  } = props;
  const total = entries.length;
  const windowEnd = Math.min(total, windowStart + windowSize);
  const visible = entries.slice(windowStart, windowEnd);
  const hiddenAbove = windowStart;
  const hiddenBelow = total - windowEnd;

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold>Library · Agents ({total})</Text>
        <Text dimColor>
          {loading && total === 0 ? 'loading…' : null}
          {error ? `error: ${error.message}` : null}
          {!loading && !error && errorCount > 0 ? `${errorCount} discovery error${errorCount === 1 ? '' : 's'}` : null}
        </Text>
      </Box>
      <Text dimColor>{libraryRoot ?? '(no library configured)'}</Text>
      <Header wrapMode={wrapMode} />
      <Text dimColor>{hiddenAbove > 0 ? `↑ ${hiddenAbove} more above` : ' '}</Text>
      {visible.length === 0 && !loading ? (
        <Text dimColor>
          {libraryRoot
            ? 'no agent library entries found at this root'
            : 'set ID_LIBRARY_ROOT or pass libraryRoot to the manager'}
        </Text>
      ) : (
        visible.map((row, i) => (
          <Row key={row.name} row={row} selected={windowStart + i === selectedIndex} wrapMode={wrapMode} />
        ))
      )}
      {Array.from(
        {
          length: Math.max(
            0,
            windowSize - Math.max(visible.length, visible.length === 0 && !loading ? 1 : 0),
          ),
        },
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
      {padRight('NAME', COLS.name)}
      {NAME_SHAPE_GAP}
      {padRight('SHAPE', COLS.shape)}
    </Text>
  );
}

function Row(props: { row: LibraryAgentRow; selected: boolean; wrapMode: TextWrapMode }): React.ReactElement {
  const { row, selected, wrapMode } = props;
  const marker = selected ? '▶ ' : '  ';
  return (
    <Text inverse={selected} wrap={wrapMode}>
      {marker}
      {padRight(row.name, COLS.name)}
      {NAME_SHAPE_GAP}
      {padRight(row.shape, COLS.shape)}
    </Text>
  );
}
