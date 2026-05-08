import React from 'react';
import { Box, Text } from 'ink';
import type { TextWrapMode } from '../util/wrap.js';

const TRUNCATE_MAX_WIDTH = 40;
const MIN_COLUMN_WIDTH = 3;

interface CommandResultTableProps {
  rows: Array<Record<string, unknown>>;
  scroll: number;
  windowSize: number;
  wrapMode?: TextWrapMode;
}

function orderedColumns(rows: Array<Record<string, unknown>>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

function isEpochMs(value: number): boolean {
  return Number.isInteger(value) && value >= 946_684_800_000 && value <= 4_102_444_800_000;
}

function shortIso(value: number): string {
  return new Date(value).toISOString().replace('.000Z', 'Z');
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return isEpochMs(value) ? shortIso(value) : String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 1) return '…';
  return `${value.slice(0, max - 1)}…`;
}

function padEnd(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function columnWidths(
  rows: Array<Record<string, unknown>>,
  columns: string[],
  wrapMode: TextWrapMode,
): number[] {
  return columns.map((column) => {
    const rawWidth = Math.max(
      column.length,
      ...rows.map((row) => formatCell(row[column]).length),
      MIN_COLUMN_WIDTH,
    );
    return wrapMode === 'wrap' ? rawWidth : Math.min(rawWidth, TRUNCATE_MAX_WIDTH);
  });
}

function renderLine(values: string[], widths: number[], wrapMode: TextWrapMode): string {
  return values
    .map((value, index) => {
      const rendered = wrapMode === 'wrap' ? value : truncate(value, widths[index]!);
      return padEnd(rendered, widths[index]!);
    })
    .join('  ');
}

export function CommandResultTable(props: CommandResultTableProps): React.ReactElement {
  const wrapMode = props.wrapMode ?? 'truncate-end';
  if (props.rows.length === 0) {
    return <Text dimColor>(no rows)</Text>;
  }

  const columns = orderedColumns(props.rows);
  const widths = columnWidths(props.rows, columns, wrapMode);
  const header = renderLine(columns, widths, wrapMode);
  const separator = widths.map((width) => '─'.repeat(width)).join('  ');
  const dataLines = props.rows.map((row) =>
    renderLine(columns.map((column) => formatCell(row[column])), widths, wrapMode),
  );
  const total = dataLines.length;
  const maxStart = Math.max(0, total - props.windowSize);
  const start = Math.min(Math.max(0, props.scroll), maxStart);
  const visible = dataLines.slice(start, start + props.windowSize);
  const padCount = Math.max(0, props.windowSize - visible.length);

  return (
    <Box flexDirection="column">
      <Text bold wrap={wrapMode}>{header}</Text>
      <Text dimColor wrap={wrapMode}>{separator}</Text>
      {visible.map((line, index) => (
        <Text key={`cmd-table-row-${start + index}`} wrap={wrapMode}>{line}</Text>
      ))}
      {Array.from({ length: padCount }, (_, index) => (
        <Text key={`cmd-table-pad-${index}`}> </Text>
      ))}
    </Box>
  );
}
