import React from 'react';
import { Box, Text } from 'ink';
import type { OutputFileRow } from '../util/output-files.js';
import { fixedWindowWrapMode, wrapLinesForViewport, type TextWrapMode } from '../util/wrap.js';

interface OutputDetailProps {
  agentName: string | null;
  file: OutputFileRow | null;
  contents: string | null;
  error: Error | null;
  positionLabel: string;
  windowSize: number;
  scrollOffset: number;
  contentWidth?: number;
  wrapMode: TextWrapMode;
}

export function OutputDetail(props: OutputDetailProps): React.ReactElement {
  const { agentName, file, contents, error, positionLabel, windowSize, scrollOffset, contentWidth = 76, wrapMode } = props;
  const lines = wrapLinesForViewport(buildBodyLines(file, contents, error), contentWidth, wrapMode);
  const total = lines.length;
  const start = clamp(scrollOffset, 0, Math.max(0, total - windowSize));
  const end = Math.min(total, start + windowSize);
  const visible = lines.slice(start, end);
  const hiddenAbove = start;
  const hiddenBelow = total - end;

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold>output · {agentName ?? '(none)'} · {file?.name ?? '(none)'}</Text>
        <Text dimColor>{positionLabel}</Text>
      </Box>
      <Text dimColor>{hiddenAbove > 0 ? `↑ ${hiddenAbove} more above` : ' '}</Text>
      <Body visible={visible} windowSize={windowSize} wrapMode={wrapMode} />
      <Text dimColor>{hiddenBelow > 0 ? `↓ ${hiddenBelow} more below` : ' '}</Text>
    </Box>
  );
}

function Body(props: { visible: string[]; windowSize: number; wrapMode: TextWrapMode }): React.ReactElement {
  const { visible, windowSize, wrapMode } = props;
  const padCount = Math.max(0, windowSize - visible.length);
  return (
    <>
      {visible.map((line, i) => (
        <Text key={`line-${i}`} wrap={fixedWindowWrapMode()}>{line || ' '}</Text>
      ))}
      {Array.from({ length: padCount }, (_, i) => (
        <Text key={`pad-${i}`}> </Text>
      ))}
    </>
  );
}

function buildBodyLines(file: OutputFileRow | null, contents: string | null, error: Error | null): string[] {
  if (error) return [`error: ${error.message}`];
  if (!file) return ['(no output file selected)'];
  return (contents ?? '').split(/\r?\n/);
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
