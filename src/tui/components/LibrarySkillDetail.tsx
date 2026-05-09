import React from 'react';
import { Box, Text } from 'ink';
import type { LibrarySkillDetailResponse } from '../api/manager.js';

interface LibrarySkillDetailProps {
  skill: LibrarySkillDetailResponse | null;
  skillName: string | null;
  loading: boolean;
  error: Error | null;
  positionLabel: string;
  windowSize: number;
  scrollOffset: number;
}

export function LibrarySkillDetail(props: LibrarySkillDetailProps): React.ReactElement {
  const { skill, skillName, loading, error, positionLabel, windowSize, scrollOffset } = props;

  const lines = buildBodyLines(skill, loading, error);
  const total = lines.length;
  const start = clamp(scrollOffset, 0, Math.max(0, total - windowSize));
  const end = Math.min(total, start + windowSize);
  const visible = lines.slice(start, end);
  const hiddenAbove = start;
  const hiddenBelow = total - end;

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold>library skill · {skill?.name ?? skillName ?? '(none)'}</Text>
        <Text dimColor>{positionLabel}</Text>
      </Box>
      <Text dimColor>{hiddenAbove > 0 ? `↑ ${hiddenAbove} more above` : ' '}</Text>
      <Body visible={visible} windowSize={windowSize} />
      <Text dimColor>{hiddenBelow > 0 ? `↓ ${hiddenBelow} more below` : ' '}</Text>
    </Box>
  );
}

function Body(props: { visible: string[]; windowSize: number }): React.ReactElement {
  const { visible, windowSize } = props;
  const padCount = Math.max(0, windowSize - visible.length);
  return (
    <>
      {visible.map((line, i) => (
        <Text key={`line-${i}`} wrap="truncate-end">{line || ' '}</Text>
      ))}
      {Array.from({ length: padCount }, (_, i) => (
        <Text key={`pad-${i}`}> </Text>
      ))}
    </>
  );
}

function buildBodyLines(
  skill: LibrarySkillDetailResponse | null,
  loading: boolean,
  error: Error | null,
): string[] {
  if (error) return [`error: ${error.message}`];
  if (!skill) return [loading ? 'loading…' : '(no library skill selected)'];

  const out: string[] = [];
  out.push(`name:        ${skill.name}`);
  if (skill.skillName && skill.skillName !== skill.name) {
    out.push(`frontmatter: ${skill.skillName}`);
  }
  out.push(`source path: ${skill.source_path}`);
  out.push(`SKILL.md:    ${skill.skillFile}`);
  out.push(`body length: ${skill.bodyLength.toLocaleString()} chars`);
  out.push('');
  out.push('── description ──');
  if (!skill.description || skill.description.trim() === '') {
    out.push('(no description in frontmatter)');
  } else {
    for (const raw of skill.description.split(/\r?\n/)) {
      const line = raw.trimEnd();
      if (line === '') {
        out.push('');
        continue;
      }
      out.push(line);
    }
  }
  return out;
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
