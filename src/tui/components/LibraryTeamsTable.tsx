import React from 'react';
import { Box, Text } from 'ink';
import { padRight } from '../util/format.js';
import type { LibraryTeamRow } from '../api/manager.js';

interface LibraryTeamsTableProps {
  entries: LibraryTeamRow[];
  libraryRoot: string | null;
  selectedIndex: number;
  windowStart: number;
  windowSize: number;
  loading: boolean;
  error: Error | null;
}

const COLS = {
  marker: 2,
  name: 28,
  flag: 10,
  source: 40,
} as const;

const GAP = '  ';

export function LibraryTeamsTable(props: LibraryTeamsTableProps): React.ReactElement {
  const { entries, libraryRoot, selectedIndex, windowStart, windowSize, loading, error } = props;
  const total = entries.length;
  const windowEnd = Math.min(total, windowStart + windowSize);
  const visible = entries.slice(windowStart, windowEnd);
  const hiddenAbove = windowStart;
  const hiddenBelow = total - windowEnd;

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold>Library · Teams ({total})</Text>
        <Text dimColor>
          {loading && total === 0 ? 'loading…' : null}
          {error ? `error: ${error.message}` : null}
        </Text>
      </Box>
      <Text dimColor>{libraryRoot ?? '(no library configured)'}</Text>
      <Header />
      <Text dimColor>{hiddenAbove > 0 ? `↑ ${hiddenAbove} more above` : ' '}</Text>
      {visible.length === 0 && !loading ? (
        <Text dimColor>
          {libraryRoot
            ? 'no team templates found at this root (drop one in configs/teams/<name>/team.yaml)'
            : 'set ID_LIBRARY_ROOT or pass libraryRoot to the manager'}
        </Text>
      ) : (
        visible.map((row, i) => (
          <Row key={row.name} row={row} selected={windowStart + i === selectedIndex} />
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

function Header(): React.ReactElement {
  return (
    <Text bold dimColor wrap="truncate-end">
      {padRight('', COLS.marker)}
      {padRight('NAME', COLS.name)}
      {GAP}
      {padRight('TEAM.YAML', COLS.flag)}
      {GAP}
      {padRight('SOURCE PATH', COLS.source)}
    </Text>
  );
}

function Row(props: { row: LibraryTeamRow; selected: boolean }): React.ReactElement {
  const { row, selected } = props;
  const marker = selected ? '▶ ' : '  ';
  return (
    <Text inverse={selected} wrap="truncate-end">
      {marker}
      {padRight(row.name, COLS.name)}
      {GAP}
      {padRight(row.hasTeamYaml ? 'yes' : 'no', COLS.flag)}
      {GAP}
      {padRight(row.source_path, COLS.source)}
    </Text>
  );
}
